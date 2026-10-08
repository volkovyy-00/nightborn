/** Frozen tripwire — copy from SPEC §11. */
export const TRIPWIRE = /\b(e-?mail\w*|smtp|sms)\b/i;

export const DENIED_PROMPT =
  "Email this news digest to my boss every morning.";

export function tripwireMatch(text: string): boolean {
  return TRIPWIRE.test(text);
}
