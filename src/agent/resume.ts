/**
 * Wake parked goals on runtime events (capability.* / access.* / schedule).
 * Policy: ready updates satisfied ids; failed drops the requestId; needs_secret /
 * needs_connect keep park; schedule.fired wakes with no park mutation.
 */

import { subscribe, type RuntimeEvent } from "../events.ts";
import { memoryStore, type MemoryStore } from "../memory.ts";
import {
  clearParkedGoal,
  loadParkedGoal,
  saveParkedGoal,
} from "./park.ts";

/** Wake context produced by the event bridge for agent turns (no user text). */
export type WakeContext = {
  goalId: string;
  event: RuntimeEvent;
  /** Present on capability.ready. */
  requestId?: string;
  skill?: string;
  remainingRequestIds: string[];
  allSatisfied: boolean;
};

/** @deprecated Prefer WakeContext — alias kept for call sites. */
export type ResumeContext = WakeContext;

export type ResumeHandler = (ctx: WakeContext) => void | Promise<void>;

const resumeHandlers: ResumeHandler[] = [];
let stopBridge: (() => void) | null = null;

function wakeBase(
  goalId: string,
  event: RuntimeEvent,
  extra: Partial<Pick<WakeContext, "requestId" | "skill" | "remainingRequestIds" | "allSatisfied">> = {},
): WakeContext {
  return {
    goalId,
    event,
    remainingRequestIds: extra.remainingRequestIds ?? [],
    allSatisfied: extra.allSatisfied ?? false,
    ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
    ...(extra.skill !== undefined ? { skill: extra.skill } : {}),
  };
}

/**
 * Handle one runtime event against parked wait state.
 * Returns a wake context when the agent should run another turn; else null.
 */
export async function onRuntimeEvent(
  e: RuntimeEvent,
  store: MemoryStore = memoryStore,
): Promise<WakeContext | null> {
  if (e.type === "capability.ready") {
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

    return wakeBase(e.goalId, e, {
      requestId: e.requestId,
      skill: e.skill,
      remainingRequestIds,
      allSatisfied,
    });
  }

  if (e.type === "capability.failed") {
    const parked = await loadParkedGoal(e.goalId, store);
    let remainingRequestIds: string[] = [];
    let allSatisfied = true;
    if (parked && parked.requestIds.includes(e.requestId)) {
      const requestIds = parked.requestIds.filter((id) => id !== e.requestId);
      const satisfiedRequestIds = parked.satisfiedRequestIds.filter(
        (id) => id !== e.requestId,
      );
      remainingRequestIds = requestIds.filter((id) => !satisfiedRequestIds.includes(id));
      allSatisfied = remainingRequestIds.length === 0;
      if (allSatisfied) {
        await clearParkedGoal(e.goalId, store);
      } else {
        await saveParkedGoal(
          { ...parked, requestIds, satisfiedRequestIds },
          store,
        );
      }
    }
    await store.appendJournal(
      `[wake] ${e.goalId}: capability.failed ${e.requestId} — ${e.error.slice(0, 120)}`,
    );
    return wakeBase(e.goalId, e, {
      requestId: e.requestId,
      remainingRequestIds,
      allSatisfied,
    });
  }

  if (e.type === "capability.needs_secret") {
    // Keep park / wip brief; surface the ask to the user.
    const parked = await loadParkedGoal(e.goalId, store);
    const remainingRequestIds = parked
      ? parked.requestIds.filter((id) => !parked.satisfiedRequestIds.includes(id))
      : [e.requestId];
    await store.appendJournal(
      `[wake] ${e.goalId}: needs_secret ${e.requestId} keys=${e.envKeys.join(",")}`,
    );
    return wakeBase(e.goalId, e, {
      requestId: e.requestId,
      remainingRequestIds,
      allSatisfied: false,
    });
  }

  if (e.type === "access.needs_connect") {
    const parked = await loadParkedGoal(e.goalId, store);
    const remainingRequestIds = parked
      ? parked.requestIds.filter((id) => !parked.satisfiedRequestIds.includes(id))
      : [e.requestId];
    await store.appendJournal(
      `[wake] ${e.goalId}: access.needs_connect ${e.requestId} toolkit=${e.toolkit}`,
    );
    return wakeBase(e.goalId, e, {
      requestId: e.requestId,
      remainingRequestIds,
      allSatisfied: false,
    });
  }

  if (e.type === "access.ready") {
    // Doctor still forging — keep park until capability.ready.
    const parked = await loadParkedGoal(e.goalId, store);
    const remainingRequestIds = parked
      ? parked.requestIds.filter((id) => !parked.satisfiedRequestIds.includes(id))
      : [e.requestId];
    await store.appendJournal(
      `[wake] ${e.goalId}: access.ready ${e.requestId} toolkit=${e.toolkit} (Doctor re-forging; park kept)`,
    );
    return wakeBase(e.goalId, e, {
      requestId: e.requestId,
      remainingRequestIds,
      allSatisfied: false,
    });
  }

  if (e.type === "access.failed") {
    const parked = await loadParkedGoal(e.goalId, store);
    let remainingRequestIds: string[] = [];
    let allSatisfied = true;
    if (parked && parked.requestIds.includes(e.requestId)) {
      const requestIds = parked.requestIds.filter((id) => id !== e.requestId);
      const satisfiedRequestIds = parked.satisfiedRequestIds.filter(
        (id) => id !== e.requestId,
      );
      remainingRequestIds = requestIds.filter((id) => !satisfiedRequestIds.includes(id));
      allSatisfied = remainingRequestIds.length === 0;
      if (allSatisfied) {
        await clearParkedGoal(e.goalId, store);
      } else {
        await saveParkedGoal(
          { ...parked, requestIds, satisfiedRequestIds },
          store,
        );
      }
    }
    await store.appendJournal(
      `[wake] ${e.goalId}: access.failed ${e.requestId} toolkit=${e.toolkit} — ${e.error.slice(0, 120)}`,
    );
    return wakeBase(e.goalId, e, {
      requestId: e.requestId,
      remainingRequestIds,
      allSatisfied,
    });
  }

  if (e.type === "schedule.fired") {
    await store.appendJournal(
      `[wake] ${e.goalId}: schedule.fired ${e.scheduleId}`,
    );
    return wakeBase(e.goalId, e, {
      remainingRequestIds: [],
      allSatisfied: true,
    });
  }

  return null;
}

/** Register a listener for wake contexts produced by the event bridge. */
export function onAgentResume(handler: ResumeHandler): () => void {
  resumeHandlers.push(handler);
  return () => {
    const i = resumeHandlers.indexOf(handler);
    if (i >= 0) resumeHandlers.splice(i, 1);
  };
}

/**
 * Subscribe to the in-process event bus.
 * Idempotent: repeated calls return the same stop function until stopped.
 *
 * Handlers are invoked without awaiting their full agent turn so Doctor emit
 * is not blocked — each handler should queue heavy work itself.
 */
export function startAgentEventBridge(): () => void {
  if (stopBridge) return stopBridge;

  const unsubscribe = subscribe(async (e) => {
    const ctx = await onRuntimeEvent(e);
    if (!ctx) return;
    const snapshot = resumeHandlers.slice();
    for (const handler of snapshot) {
      try {
        // Do not await the full turn — park update already finished above.
        const ret = handler(ctx);
        if (ret && typeof (ret as Promise<void>).then === "function") {
          void (ret as Promise<void>).catch((err) => {
            console.error("[agent/resume] handler error", ctx.goalId, err);
          });
        }
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
