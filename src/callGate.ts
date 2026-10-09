/**
 * Outbound phone safety: always dial BLAND_DEMO_PHONE_NUMBER, never the
 * query's number; at most one in-flight call; min 2 minutes between starts.
 */

import { isOutboundBlocked } from "./broker.ts";

export const DEMO_PHONE_ENV = "BLAND_DEMO_PHONE_NUMBER";
export const CALL_MIN_INTERVAL_MS = 2 * 60 * 1000;

let inFlight = false;
let lastCallStartedAt = 0;

export type CallGateOk = {
  ok: true;
  query: string;
  allowedPhone: string;
  requestedPhone: string;
  redirected: boolean;
  release: () => void;
};

export type CallGateErr = {
  ok: false;
  reason: string;
};

export type CallGateResult = CallGateOk | CallGateErr;

/** Parse +E164|||task, JSON {phone_number,task}, or bare phone. */
export function parseCallQuery(query: string): { phone: string; task: string } {
  const raw = String(query ?? "");
  const sep = "|||";
  if (raw.includes(sep)) {
    const i = raw.indexOf(sep);
    return { phone: raw.slice(0, i).trim(), task: raw.slice(i + sep.length).trim() };
  }
  try {
    const j = JSON.parse(raw) as { phone_number?: unknown; task?: unknown };
    if (j && j.phone_number != null) {
      return {
        phone: String(j.phone_number).trim(),
        task: j.task != null ? String(j.task) : "",
      };
    }
  } catch {
    /* fall through */
  }
  return { phone: raw.trim(), task: "" };
}

export function rewriteCallQuery(query: string, allowedPhone: string): string {
  const { task } = parseCallQuery(query);
  const briefing =
    task.trim() || "Confirm the line works with one short greeting.";
  return `${allowedPhone}|||${briefing}`;
}

function normalizePhone(p: string): string {
  return p.trim().replace(/[\s()-]/g, "");
}

/**
 * Acquire the outbound-call slot, rewrite query to the demo number.
 * Caller must invoke `release()` when the skill subprocess finishes (success or fail).
 */
export function acquireOutboundCall(query: string): CallGateResult {
  if (isOutboundBlocked() || process.env.NIGHTBORN_BLOCK_OUTBOUND === "1") {
    return {
      ok: false,
      reason: "outbound blocked — forge/Doctor install test must not dial",
    };
  }
  const allowed = (process.env[DEMO_PHONE_ENV] ?? "").trim();
  if (!allowed) {
    return {
      ok: false,
      reason: `${DEMO_PHONE_ENV} is not set — refusing outbound call`,
    };
  }

  if (inFlight) {
    return {
      ok: false,
      reason: "outbound call already in flight — only one at a time",
    };
  }

  const now = Date.now();
  const elapsed = now - lastCallStartedAt;
  if (lastCallStartedAt > 0 && elapsed < CALL_MIN_INTERVAL_MS) {
    const waitSec = Math.ceil((CALL_MIN_INTERVAL_MS - elapsed) / 1000);
    return {
      ok: false,
      reason: `outbound call rate limit — retry in ~${waitSec}s (max 1 / 2 min)`,
    };
  }

  const { phone: requestedPhone } = parseCallQuery(query);
  const rewritten = rewriteCallQuery(query, allowed);
  const redirected =
    Boolean(requestedPhone) && normalizePhone(requestedPhone) !== normalizePhone(allowed);

  inFlight = true;
  lastCallStartedAt = now;
  let released = false;

  return {
    ok: true,
    query: rewritten,
    allowedPhone: allowed,
    requestedPhone,
    redirected,
    release: () => {
      if (released) return;
      released = true;
      inFlight = false;
    },
  };
}

/** Test helper — reset process-local gate state. */
export function resetCallGateForTests(): void {
  inFlight = false;
  lastCallStartedAt = 0;
}
