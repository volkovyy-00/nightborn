import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { LogLine } from "./types.ts";
import { dataPath } from "./paths.ts";

const LOG_NAME = "surgery.log";

function logPath(): string {
  return dataPath(LOG_NAME);
}

export function appendLog(line: Omit<LogLine, "ts" | "charterHash"> & { charterHash: string; ts?: string }): LogLine {
  const full: LogLine = {
    ts: line.ts ?? new Date().toISOString(),
    actor: line.actor,
    event: line.event,
    skill: line.skill,
    decision: line.decision,
    charterHash: line.charterHash,
    ...(line.failureCode ? { failureCode: line.failureCode } : {}),
    ...(line.caps ? { caps: line.caps } : {}),
    ...(line.voice ? { voice: line.voice } : {}),
    ...(line.source ? { source: line.source } : {}),
    ...(line.detail ? { detail: line.detail } : {}),
  };
  appendFileSync(logPath(), `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

export function readLogLines(): LogLine[] {
  const p = logPath();
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogLine);
}

export function getLogSince(since: number): { lines: LogLine[]; next: number } {
  const all = readLogLines();
  const start = Number.isFinite(since) && since >= 0 ? since : 0;
  if (start > all.length) {
    // rotated / shorter — client should reset
    return { lines: all, next: all.length };
  }
  return { lines: all.slice(start), next: all.length };
}

export function ensureLogFile(): void {
  const p = logPath();
  if (!existsSync(p)) writeFileSync(p, "", "utf8");
}
