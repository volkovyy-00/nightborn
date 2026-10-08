/**
 * Park a goal while capabilities are building. Wait state lives in memory/.
 */

import { memoryStore, type MemoryStore } from "../memory.ts";
import type { ParkedGoal } from "./types.ts";

export type ParkGoalInput = {
  goalId: string;
  requestIds: string[];
  reason: string;
};

/** Relative path under memory/ for a goal's wait JSON. */
export function waitStatePath(goalId: string): string {
  const safe = sanitizeGoalId(goalId);
  return `waits/${safe}.json`;
}

function sanitizeGoalId(goalId: string): string {
  const trimmed = goalId.trim();
  if (!trimmed) throw new Error("goalId must be non-empty");
  // Keep path segment boring: alnum, underscore, hyphen, dot.
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_");
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`goalId sanitizes to an unsafe path segment: ${goalId}`);
  }
  return safe;
}

function parseParked(raw: string, goalId: string): ParkedGoal | null {
  try {
    const data = JSON.parse(raw) as Partial<ParkedGoal>;
    if (
      typeof data.goalId !== "string" ||
      data.goalId !== goalId ||
      data.status !== "waiting_on_capabilities" ||
      !Array.isArray(data.requestIds) ||
      !Array.isArray(data.satisfiedRequestIds) ||
      typeof data.reason !== "string" ||
      typeof data.parkedAt !== "string"
    ) {
      return null;
    }
    return {
      goalId: data.goalId,
      requestIds: data.requestIds.filter((id): id is string => typeof id === "string"),
      reason: data.reason,
      satisfiedRequestIds: data.satisfiedRequestIds.filter(
        (id): id is string => typeof id === "string",
      ),
      status: "waiting_on_capabilities",
      parkedAt: data.parkedAt,
    };
  } catch {
    return null;
  }
}

/** Persist wait state for a goal (overwrite). */
export async function parkGoal(
  input: ParkGoalInput,
  store: MemoryStore = memoryStore,
): Promise<ParkedGoal> {
  const parked: ParkedGoal = {
    goalId: input.goalId,
    requestIds: [...input.requestIds],
    reason: input.reason,
    satisfiedRequestIds: [],
    status: "waiting_on_capabilities",
    parkedAt: new Date().toISOString(),
  };
  await store.write(waitStatePath(input.goalId), `${JSON.stringify(parked, null, 2)}\n`);
  await store.appendJournal(
    `[park] ${input.goalId}: ${input.reason} waiting on [${input.requestIds.join(", ")}]`,
  );
  return parked;
}

/** Load parked wait state, or null if missing/invalid. */
export async function loadParkedGoal(
  goalId: string,
  store: MemoryStore = memoryStore,
): Promise<ParkedGoal | null> {
  const raw = await store.read(waitStatePath(goalId));
  if (raw == null) return null;
  return parseParked(raw, goalId);
}

/** Update an existing parked goal (e.g. mark requestIds satisfied). */
export async function saveParkedGoal(
  parked: ParkedGoal,
  store: MemoryStore = memoryStore,
): Promise<void> {
  await store.write(waitStatePath(parked.goalId), `${JSON.stringify(parked, null, 2)}\n`);
}

/** Clear wait state after all capabilities are ready (or abandon). */
export async function clearParkedGoal(
  goalId: string,
  store: MemoryStore = memoryStore,
): Promise<void> {
  // MemoryStore has no delete — overwrite with a cleared marker for auditability.
  const cleared = {
    goalId,
    status: "cleared" as const,
    clearedAt: new Date().toISOString(),
  };
  await store.write(waitStatePath(goalId), `${JSON.stringify(cleared, null, 2)}\n`);
}
