import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { LogLine } from "./types.ts";
import { dataPath } from "./paths.ts";

/** Where surgery lines go — keeps smoke/judge out of the host UI log. */
export type LogSource = "live" | "fixture" | "smoke";

/**
 * Channel for this process:
 * - `SURGERY_CHANNEL=smoke|fixture|live` wins
 * - else `SMOKE_AGENT=1` → smoke
 * - else `JUDGE_MODE=1` → fixture
 * - else live (`surgery.log` — what the UI polls)
 */
export function resolveLogSource(): LogSource {
  const raw = (process.env.SURGERY_CHANNEL || process.env.SURGERY_SOURCE || "")
    .trim()
    .toLowerCase();
  if (raw === "smoke" || raw === "fixture" || raw === "live") return raw;
  if (process.env.SMOKE_AGENT === "1") return "smoke";
  if (process.env.JUDGE_MODE === "1") return "fixture";
  return "live";
}

function logFileName(source: LogSource): string {
  if (source === "smoke") return "surgery.smoke.log";
  if (source === "fixture") return "surgery.fixture.log";
  return "surgery.log";
}

function logPath(source: LogSource = resolveLogSource()): string {
  return dataPath(logFileName(source));
}

/** Active log path for this process (smoke/fixture/live). */
export function activeLogPath(): string {
  return logPath();
}

export function appendLog(
  line: Omit<LogLine, "ts" | "charterHash"> & { charterHash: string; ts?: string },
): LogLine {
  // File channel is always the process channel (smoke/fixture/live).
  // `line.source` is only a tag (e.g. runner fixture vs live job) — it must not
  // redirect smoke/judge lines into the UI's surgery.log.
  const channel = resolveLogSource();
  const tag: LogSource = (line.source as LogSource | undefined) ?? channel;
  const full: LogLine = {
    ts: line.ts ?? new Date().toISOString(),
    actor: line.actor,
    event: line.event,
    skill: line.skill,
    decision: line.decision,
    charterHash: line.charterHash,
    source: tag,
    ...(line.failureCode ? { failureCode: line.failureCode } : {}),
    ...(line.caps ? { caps: line.caps } : {}),
    ...(line.voice ? { voice: line.voice } : {}),
    ...(line.detail ? { detail: line.detail } : {}),
  };
  appendFileSync(logPath(channel), `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

export function readLogLines(source: LogSource = "live"): LogLine[] {
  const p = logPath(source);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogLine);
}

/** UI host: always read live `surgery.log` unless `source` query opts in. */
export function getLogSince(
  since: number,
  source: LogSource = "live",
): { lines: LogLine[]; next: number; source: LogSource; hostChannel: LogSource } {
  const hostChannel = resolveLogSource();
  const all = readLogLines(source);
  const start = Number.isFinite(since) && since >= 0 ? since : 0;
  if (start > all.length) {
    return { lines: all, next: all.length, source, hostChannel };
  }
  return { lines: all.slice(start), next: all.length, source, hostChannel };
}

export function ensureLogFile(source: LogSource = resolveLogSource()): void {
  const p = logPath(source);
  if (!existsSync(p)) writeFileSync(p, "", "utf8");
}
