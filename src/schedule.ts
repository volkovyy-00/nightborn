/**
 * Once + cron scheduler — persists under schedules/, emits schedule.fired.
 *
 * Timer is in-process (setInterval). Call startScheduler()/stopScheduler()
 * from the host lifecycle (T09). No external cron library.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { emit } from "./events.ts";
import { repoPath } from "./paths.ts";

export type ScheduleSpec =
  | { kind: "once"; at: string; goalId: string; note?: string }
  | { kind: "cron"; expr: string; goalId: string; note?: string };

export type ScheduleRecord = ScheduleSpec & {
  id: string;
  createdAt: string;
  /** ISO timestamp of last fire (cron dedupe / audit). */
  lastFiredAt?: string;
};

const SCHEDULES_DIR = repoPath("schedules");
const DEFAULT_TICK_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

function schedulesDir(): string {
  return SCHEDULES_DIR;
}

function fileFor(id: string): string {
  if (!/^[\w.-]+$/.test(id)) {
    throw new Error(`invalid schedule id: ${id}`);
  }
  return path.join(schedulesDir(), `${id}.json`);
}

function newId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `sched_${ts}_${rnd}`;
}

/** Ensure schedules/ exists. */
async function ensureDir(): Promise<void> {
  await mkdir(schedulesDir(), { recursive: true });
}

/** Persist a new schedule; returns the stored record. */
export async function addSchedule(spec: ScheduleSpec): Promise<ScheduleRecord> {
  validateSpec(spec);
  await ensureDir();
  const record: ScheduleRecord = {
    ...spec,
    id: newId(),
    createdAt: new Date().toISOString(),
  };
  await writeFile(fileFor(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/** Remove a schedule by id (no-op if missing). */
export async function removeSchedule(id: string): Promise<void> {
  try {
    await unlink(fileFor(id));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

/** List all persisted schedules. */
export async function listSchedules(): Promise<ScheduleRecord[]> {
  await ensureDir();
  const names = await readdir(schedulesDir());
  const out: ScheduleRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const abs = path.join(schedulesDir(), name);
    try {
      const raw = await readFile(abs, "utf8");
      const parsed = JSON.parse(raw) as ScheduleRecord;
      if (parsed && typeof parsed.id === "string" && parsed.kind) {
        out.push(parsed);
      }
    } catch {
      // skip corrupt / partial files
    }
  }
  return out;
}

function validateSpec(spec: ScheduleSpec): void {
  if (!spec || typeof spec !== "object") throw new Error("schedule spec required");
  if (typeof spec.goalId !== "string" || !spec.goalId.trim()) {
    throw new Error("schedule.goalId required");
  }
  if (spec.kind === "once") {
    if (typeof spec.at !== "string" || Number.isNaN(Date.parse(spec.at))) {
      throw new Error(`schedule.at must be a valid ISO timestamp (got ${String(spec.at)})`);
    }
    return;
  }
  if (spec.kind === "cron") {
    if (typeof spec.expr !== "string" || !spec.expr.trim()) {
      throw new Error("schedule.expr required for cron");
    }
    // Throws if malformed.
    parseCron(spec.expr);
    return;
  }
  throw new Error(`unknown schedule.kind: ${(spec as { kind: string }).kind}`);
}

async function saveRecord(record: ScheduleRecord): Promise<void> {
  await writeFile(fileFor(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * One timer tick: load schedules, fire due ones, emit schedule.fired.
 * Safe to call from tests; startScheduler uses this on an interval.
 */
export async function tickScheduler(now: Date = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const schedules = await listSchedules();
    for (const sched of schedules) {
      try {
        if (sched.kind === "once") {
          await maybeFireOnce(sched, now);
        } else if (sched.kind === "cron") {
          await maybeFireCron(sched, now);
        }
      } catch (err) {
        console.error("[schedule] tick error", sched.id, err);
      }
    }
  } finally {
    ticking = false;
  }
}

async function maybeFireOnce(sched: ScheduleRecord & { kind: "once" }, now: Date): Promise<void> {
  const atMs = Date.parse(sched.at);
  if (Number.isNaN(atMs) || now.getTime() < atMs) return;
  await emit({ type: "schedule.fired", scheduleId: sched.id, goalId: sched.goalId });
  await removeSchedule(sched.id);
}

async function maybeFireCron(sched: ScheduleRecord & { kind: "cron" }, now: Date): Promise<void> {
  if (!cronMatches(sched.expr, now)) return;
  const minuteKey = minuteIso(now);
  if (sched.lastFiredAt && minuteIso(new Date(sched.lastFiredAt)) === minuteKey) {
    return; // already fired this local minute
  }
  await emit({ type: "schedule.fired", scheduleId: sched.id, goalId: sched.goalId });
  const updated: ScheduleRecord = { ...sched, lastFiredAt: now.toISOString() };
  await saveRecord(updated);
}

/** Local-time YYYY-MM-DDTHH:MM for cron dedupe. */
function minuteIso(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${day}T${h}:${mi}`;
}

/** Start in-process timer. Idempotent. */
export function startScheduler(opts?: { intervalMs?: number }): void {
  if (timer) return;
  const ms = opts?.intervalMs ?? DEFAULT_TICK_MS;
  // Fire soon after start so near-due once schedules are not delayed a full interval.
  void tickScheduler();
  timer = setInterval(() => {
    void tickScheduler();
  }, ms);
  // Allow process to exit if this is the only handle (tests / short scripts).
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
}

/** Stop the in-process timer. Idempotent. */
export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** Whether the scheduler interval is running. */
export function isSchedulerRunning(): boolean {
  return timer !== null;
}

// --- tiny 5-field cron (minute hour dom month dow) — no deps ---

type CronField = {
  /** If set, any value in this set matches. */
  values: Set<number> | null; // null = wildcard (*)
};

type CronExpr = {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
};

const CRON_BOUNDS: Record<keyof CronExpr, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  // 0 and 7 both Sunday (standard cron).
  dow: { min: 0, max: 7 },
};

/** Parse `m h dom mon dow`; throws on malformed expr. */
export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expr must have 5 fields (got ${parts.length}): ${expr}`);
  }
  const keys: (keyof CronExpr)[] = ["minute", "hour", "dom", "month", "dow"];
  const out = {} as CronExpr;
  for (let i = 0; i < 5; i++) {
    const key = keys[i]!;
    out[key] = parseCronField(parts[i]!, CRON_BOUNDS[key]);
  }
  return out;
}

function parseCronField(field: string, bound: { min: number; max: number }): CronField {
  if (field === "*") return { values: null };
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!stepMatch) {
      throw new Error(`invalid cron field segment: ${part}`);
    }
    const range = stepMatch[1]!;
    const step = stepMatch[2] ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step: ${part}`);
    }
    let start = bound.min;
    let end = bound.max;
    if (range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        start = a!;
        end = b!;
      } else {
        start = Number(range);
        end = start;
      }
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < bound.min ||
      end > bound.max ||
      start > end
    ) {
      throw new Error(`cron value out of range: ${part}`);
    }
    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }
  return { values };
}

function fieldMatches(field: CronField, value: number, isDow: boolean): boolean {
  if (field.values === null) return true;
  if (field.values.has(value)) return true;
  // Sunday: accept both 0 and 7
  if (isDow && value === 0 && field.values.has(7)) return true;
  if (isDow && value === 7 && field.values.has(0)) return true;
  return false;
}

/** True if expr matches local wall-clock of `now`. */
export function cronMatches(expr: string, now: Date = new Date()): boolean {
  const c = parseCron(expr);
  const minute = now.getMinutes();
  const hour = now.getHours();
  const dom = now.getDate();
  const month = now.getMonth() + 1;
  const dow = now.getDay(); // 0=Sun
  return (
    fieldMatches(c.minute, minute, false) &&
    fieldMatches(c.hour, hour, false) &&
    fieldMatches(c.dom, dom, false) &&
    fieldMatches(c.month, month, false) &&
    fieldMatches(c.dow, dow, true)
  );
}
