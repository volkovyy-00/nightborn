/**
 * In-process UI notices — resume / tool-run status that the chat can poll
 * after the Talk HTTP turn has already returned (parked on wait).
 */

export type UiNoticeKind = "status" | "reply";

export type UiNotice = {
  id: number;
  ts: string;
  kind: UiNoticeKind;
  text: string;
  skill?: string | null;
  goalId?: string;
};

const MAX = 120;
let nextId = 1;
const notices: UiNotice[] = [];

export function pushNotice(
  partial: Omit<UiNotice, "id" | "ts"> & { ts?: string },
): UiNotice {
  const full: UiNotice = {
    id: nextId++,
    ts: partial.ts ?? new Date().toISOString(),
    kind: partial.kind,
    text: partial.text,
    ...(partial.skill != null ? { skill: partial.skill } : {}),
    ...(partial.goalId ? { goalId: partial.goalId } : {}),
  };
  notices.push(full);
  while (notices.length > MAX) notices.shift();
  return full;
}

/** Notices with id > since (exclusive). */
export function getNoticesSince(since: number): {
  notices: UiNotice[];
  next: number;
} {
  const s = Number.isFinite(since) ? since : 0;
  const batch = notices.filter((n) => n.id > s);
  const next = batch.length ? batch[batch.length - 1]!.id : s;
  return { notices: batch, next };
}
