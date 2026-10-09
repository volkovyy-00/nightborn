/**
 * Append-only goal transcript — source of truth for UI chat (SSE) and Pi history.
 * Disk: memory/goals/<goalId>.messages.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoPath } from "./paths.ts";

export type TranscriptRole = "user" | "assistant" | "status";

export type TranscriptMessage = {
  id: number;
  goalId: string;
  ts: string;
  role: TranscriptRole;
  text: string;
  skill?: string | null;
};

export type TranscriptListener = (msg: TranscriptMessage) => void;

const MAX_RAM = 500;
let nextId = 1;
const ram: TranscriptMessage[] = [];
const listeners = new Set<TranscriptListener>();
let rehydrated = false;

function goalsDir(): string {
  return repoPath("memory", "goals");
}

function fileFor(goalId: string): string {
  const safe = goalId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(goalsDir(), `${safe}.messages.jsonl`);
}

/** Rehydrate nextId + recent RAM from on-disk jsonl (idempotent). */
export function rehydrateTranscript(): void {
  if (rehydrated) return;
  rehydrated = true;
  const dir = goalsDir();
  if (!existsSync(dir)) return;
  let maxId = 0;
  const loaded: TranscriptMessage[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".messages.jsonl")) continue;
    const raw = readFileSync(path.join(dir, name), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as TranscriptMessage;
        if (typeof m.id === "number" && m.id > maxId) maxId = m.id;
        if (m.goalId && m.text != null && m.role) loaded.push(m);
      } catch {
        /* skip bad line */
      }
    }
  }
  loaded.sort((a, b) => a.id - b.id);
  nextId = maxId + 1;
  const tail = loaded.slice(-MAX_RAM);
  ram.length = 0;
  ram.push(...tail);
}

export function subscribe(listener: TranscriptListener): () => void {
  rehydrateTranscript();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function appendMessage(
  partial: Omit<TranscriptMessage, "id" | "ts"> & { ts?: string },
): TranscriptMessage {
  rehydrateTranscript();
  const msg: TranscriptMessage = {
    id: nextId++,
    ts: partial.ts ?? new Date().toISOString(),
    goalId: partial.goalId,
    role: partial.role,
    text: partial.text,
    ...(partial.skill != null ? { skill: partial.skill } : {}),
  };
  try {
    const dir = goalsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(fileFor(msg.goalId), `${JSON.stringify(msg)}\n`, "utf8");
  } catch (err) {
    console.error("[transcript] write failed", msg.goalId, err);
  }
  ram.push(msg);
  while (ram.length > MAX_RAM) ram.shift();
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch (err) {
      console.error("[transcript] listener error", err);
    }
  }
  return msg;
}

/** Messages with id > since (exclusive). Optional goalId filter. */
export function getMessagesSince(
  since: number,
  goalId?: string,
): { messages: TranscriptMessage[]; next: number } {
  rehydrateTranscript();
  const s = Number.isFinite(since) ? since : 0;
  let batch = ram.filter((m) => m.id > s);
  if (goalId) batch = batch.filter((m) => m.goalId === goalId);
  const next = batch.length ? batch[batch.length - 1]!.id : s;
  return { messages: batch, next };
}

export function loadGoalMessages(goalId: string): TranscriptMessage[] {
  rehydrateTranscript();
  const p = fileFor(goalId);
  if (!existsSync(p)) return [];
  const out: TranscriptMessage[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TranscriptMessage);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Last N user/assistant turns for Pi (session-wide from RAM). */
export function recentForTalk(n = 10): { role: "user" | "assistant"; text: string }[] {
  rehydrateTranscript();
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const m of ram) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    turns.push({ role: m.role, text: m.text });
  }
  return turns.slice(-n);
}
