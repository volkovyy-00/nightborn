/**
 * In-process event bus for non-interrupting runtime notifications.
 *
 * Delivery policy: serial await — emit runs each subscribed handler in
 * subscription order, awaiting completion, with try/catch per handler so one
 * failure does not skip the rest. No Redis; no HTTP/SSE in this module.
 */

export type RuntimeEvent =
  | { type: "capability.ready"; requestId: string; goalId: string; skill: string }
  | { type: "capability.failed"; requestId: string; goalId: string; error: string }
  | {
      type: "capability.needs_secret";
      requestId: string;
      envKeys: string[];
      message: string;
    }
  | { type: "secrets.provided"; envKeys: string[] }
  | { type: "schedule.fired"; scheduleId: string; goalId: string }
  | { type: "audit.flag"; auditId: string; note: string };

export type RuntimeEventHandler = (e: RuntimeEvent) => void | Promise<void>;

const handlers: RuntimeEventHandler[] = [];

/** Emit an event; await handlers serially (errors isolated per handler). */
export async function emit(e: RuntimeEvent): Promise<void> {
  // Snapshot so subscribe/unsubscribe during delivery does not reshuffle this emit.
  const snapshot = handlers.slice();
  for (const handler of snapshot) {
    try {
      await handler(e);
    } catch (err) {
      console.error("[events] handler error", e.type, err);
    }
  }
}

/** Subscribe; returns unsubscribe. */
export function subscribe(handler: RuntimeEventHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}
