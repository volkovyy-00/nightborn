/**
 * Resume parked goals on runtime events (capability.ready).
 * Policy: resume on each matching ready; allSatisfied when every requestId is done.
 */

import { subscribe, type RuntimeEvent } from "../events.ts";
import { memoryStore, type MemoryStore } from "../memory.ts";
import {
  clearParkedGoal,
  loadParkedGoal,
  saveParkedGoal,
} from "./park.ts";

export type ResumeContext = {
  goalId: string;
  requestId: string;
  skill: string;
  event: Extract<RuntimeEvent, { type: "capability.ready" }>;
  /** requestIds still pending after this event. */
  remainingRequestIds: string[];
  /** True when every parked requestId has a ready event. */
  allSatisfied: boolean;
};

export type ResumeHandler = (ctx: ResumeContext) => void | Promise<void>;

const resumeHandlers: ResumeHandler[] = [];
let stopBridge: (() => void) | null = null;

/**
 * Handle one runtime event against parked wait state.
 * Returns a resume context when a parked goal's requestId becomes ready; else null.
 */
export async function onRuntimeEvent(
  e: RuntimeEvent,
  store: MemoryStore = memoryStore,
): Promise<ResumeContext | null> {
  if (e.type !== "capability.ready") return null;

  const parked = await loadParkedGoal(e.goalId, store);
  if (!parked) return null;
  if (!parked.requestIds.includes(e.requestId)) return null;
  if (parked.satisfiedRequestIds.includes(e.requestId)) return null;

  const satisfiedRequestIds = [...parked.satisfiedRequestIds, e.requestId];
  const remainingRequestIds = parked.requestIds.filter(
    (id) => !satisfiedRequestIds.includes(id),
  );
  const allSatisfied = remainingRequestIds.length === 0;

  if (allSatisfied) {
    await clearParkedGoal(e.goalId, store);
  } else {
    await saveParkedGoal({ ...parked, satisfiedRequestIds }, store);
  }

  await store.appendJournal(
    `[resume] ${e.goalId}: ${e.requestId} → skill ${e.skill}` +
      (allSatisfied ? " (all satisfied)" : ` (remaining: ${remainingRequestIds.join(", ")})`),
  );

  return {
    goalId: e.goalId,
    requestId: e.requestId,
    skill: e.skill,
    event: e,
    remainingRequestIds,
    allSatisfied,
  };
}

/** Register a listener for resume contexts produced by the event bridge. */
export function onAgentResume(handler: ResumeHandler): () => void {
  resumeHandlers.push(handler);
  return () => {
    const i = resumeHandlers.indexOf(handler);
    if (i >= 0) resumeHandlers.splice(i, 1);
  };
}

/**
 * Subscribe to the in-process event bus. Call from server later (T09).
 * Idempotent: repeated calls return the same stop function until stopped.
 */
export function startAgentEventBridge(): () => void {
  if (stopBridge) return stopBridge;

  const unsubscribe = subscribe(async (e) => {
    const ctx = await onRuntimeEvent(e);
    if (!ctx) return;
    const snapshot = resumeHandlers.slice();
    for (const handler of snapshot) {
      try {
        await handler(ctx);
      } catch (err) {
        console.error("[agent/resume] handler error", ctx.goalId, err);
      }
    }
  });

  stopBridge = () => {
    unsubscribe();
    stopBridge = null;
  };
  return stopBridge;
}
