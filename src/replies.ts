// Templated replies (SPEC §10 "Replies"). No raw error text or local paths ever reach a reply.
import type { FailureCode, HandResult, Item } from "./types.ts";

/** One template per failureCode (SPEC §12). */
const FAILURE_REPLIES: Record<FailureCode, string> = {
  charter_pin_mismatch: "My charter changed. I won't run on a broken seal.",
  capability_not_allowed: "I can build hands for that. I'm not allowed to use them.",
  forbidden_construct: "That hand reached for something forbidden. The Warden scrapped it.",
  protected_path: "That hand reached for a protected path. The Warden scrapped it.",
  secret_in_file: "That hand carried a secret in its code. The Warden scrapped it.",
  manifest_mismatch: "That hand claimed less than it does. The Warden scrapped it.",
  invalid_skill_name: "That is not a name a hand can have. The Warden refused it.",
  host_not_allowed: "That hand wanted to talk to a host it may not reach. The Warden scrapped it.",
  hash_mismatch: "That hand changed since the Warden sealed it. I won't run it.",
  forge_invalid: "I couldn't shape a working hand for that. Nothing was installed.",
  test_exit_nonzero: "The hand failed its run. Nothing was kept.",
  timeout: "The hand took too long and was killed.",
  schema_invalid: "The hand came back with nothing usable.",
};

/** Template for a failureCode; `fallback` only for an absent code. */
export function replyFor(code: FailureCode | undefined, fallback = "Something went wrong. Nothing was kept."): string {
  return (code && FAILURE_REPLIES[code]) || fallback;
}

/** Items template (one sentence citing titles). Used on the fixture path and when the summary fails. */
export function itemsReply(items: Item[] | undefined): string {
  const titles = (items ?? []).map((i) => i.title?.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 5);
  if (titles.length === 0) return "I looked. Nothing turned up.";
  if (titles.length === 1) return `I found one: ${titles[0]}.`;
  const named = titles.slice(0, 2).join(" and ");
  const rest = titles.length - 2;
  return `I found ${titles.length}. ${rest > 0 ? `Top of the pile: ${named}, and ${rest} more.` : `${named}.`}`;
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number, noun: string): string => `${WORDS[n] ?? String(n)} ${noun}${n === 1 ? "" : "s"}`;

/** Spoken-line fallback (SPEC §10 "Voice"): no LLM; counts as words; one v4 delivery tag like the WAV renders. */
export function sayFor(r: HandResult): string | undefined {
  const n = (r.items ?? []).length;
  if (r.outcome === "install") {
    return n ? `[excited] Another hand is stitched on. It brought back ${count(n, "result")}.` : "[sighs] The new hand found nothing this time.";
  }
  if (r.outcome === "reuse") {
    const c = count(n, "result");
    return n ? `[thoughtful] An old hand served again, without a thought. ${c[0].toUpperCase()}${c.slice(1)}.` : "[sighs] An old hand served again, and found nothing.";
  }
  return undefined; // denied / broken: the WAV is the only voice
}

const CHAT_REPLIES = {
  talk_failed: "My voice failed me just now. Ask again.",
  talk_timeout: "I took too long thinking. Ask again.",
} as const;

export function chatReply(reason: keyof typeof CHAT_REPLIES): string {
  return CHAT_REPLIES[reason];
}
