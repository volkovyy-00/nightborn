/**
 * Append-only, goal-centric audit sink (eval-ready for a later Jev).
 * Independent of surgery.log / Doctor / agent loop.
 *
 * Layout: one JSONL file per UTC day under audit/YYYY-MM-DD.jsonl
 * (see audit/README.md). Never persists raw secret values.
 */

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { repoPath } from "./paths.ts";

export type AuditEvalHint = {
  decision?: "approve" | "deny" | "raise" | "pending";
  rulesRef?: string;
};

export type AuditRecord = {
  id: string;
  ts: string;
  type: string;
  summary: string;
  why?: string;
  goalId?: string;
  data?: Record<string, unknown>;
  evalHint?: AuditEvalHint;
};

export type AuditAppendInput = Omit<AuditRecord, "id" | "ts"> & {
  id?: string;
  ts?: string;
};

export type AuditListFilter = {
  goalId?: string;
  since?: string;
};

const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /^(.*[_-]?)?(secret|password|passwd|token|api[_-]?key|authorization|bearer|credential)([_-].*)?$/i;

function auditRoot(): string {
  return repoPath("audit");
}

function dayFileName(ts: string): string {
  const day = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return `${new Date().toISOString().slice(0, 10)}.jsonl`;
  }
  return `${day}.jsonl`;
}

function newId(): string {
  return `aud_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** Values from env that must never appear in audit records. */
function secretEnvValues(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v.length < 8) continue;
    if (/API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|BEARER/i.test(k)) {
      out.push(v);
    }
  }
  // Longest first so overlapping values redact cleanly.
  return out.sort((a, b) => b.length - a.length);
}

function scrubString(s: string, secrets: string[]): string {
  let out = s;
  for (const secret of secrets) {
    if (!secret || !out.includes(secret)) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

function scrubValue(value: unknown, secrets: string[]): unknown {
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value, secrets);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, secrets));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = scrubValue(v, secrets);
      }
    }
    return out;
  }
  return value;
}

/** Strip raw secrets from a record before persist. Env key *names* stay; values go. */
export function scrubRecord(record: AuditRecord): AuditRecord {
  const secrets = secretEnvValues();
  const scrubbed: AuditRecord = {
    id: record.id,
    ts: record.ts,
    type: record.type,
    summary: scrubString(record.summary, secrets),
  };
  if (record.why !== undefined) scrubbed.why = scrubString(record.why, secrets);
  if (record.goalId !== undefined) scrubbed.goalId = record.goalId;
  if (record.data !== undefined) {
    scrubbed.data = scrubValue(record.data, secrets) as Record<string, unknown>;
  }
  if (record.evalHint !== undefined) scrubbed.evalHint = { ...record.evalHint };
  return scrubbed;
}

async function ensureAuditDir(): Promise<void> {
  await mkdir(auditRoot(), { recursive: true });
}

/** Append one audit record (generates id/ts when omitted). */
export async function append(input: AuditAppendInput): Promise<AuditRecord> {
  const ts = input.ts ?? new Date().toISOString();
  const record = scrubRecord({
    id: input.id ?? newId(),
    ts,
    type: input.type,
    summary: input.summary,
    ...(input.why !== undefined ? { why: input.why } : {}),
    ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(input.evalHint !== undefined ? { evalHint: input.evalHint } : {}),
  });

  await ensureAuditDir();
  const file = path.join(auditRoot(), dayFileName(record.ts));
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

async function listDayFiles(): Promise<string[]> {
  await ensureAuditDir();
  const names = await readdir(auditRoot());
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
}

async function readJsonl(filePath: string): Promise<AuditRecord[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  const out: AuditRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

/** List records, optionally filtered by goalId and/or ts >= since (ISO). */
export async function list(filter: AuditListFilter = {}): Promise<AuditRecord[]> {
  const files = await listDayFiles();
  const sinceDay = filter.since?.slice(0, 10);
  const selected =
    sinceDay && /^\d{4}-\d{2}-\d{2}$/.test(sinceDay)
      ? files.filter((f) => f.slice(0, 10) >= sinceDay)
      : files;

  const records: AuditRecord[] = [];
  for (const name of selected) {
    const chunk = await readJsonl(path.join(auditRoot(), name));
    for (const r of chunk) {
      if (filter.goalId !== undefined && r.goalId !== filter.goalId) continue;
      if (filter.since !== undefined && r.ts < filter.since) continue;
      records.push(r);
    }
  }
  return records;
}
