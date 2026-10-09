import type { FailureCode } from "./types.ts";

const MAP: Partial<Record<FailureCode, string>> = {
  capability_not_allowed: "I can build hands for that. I'm not allowed to use them.",
  forbidden_construct: "That hand used a forbidden construct. Scrapped.",
  protected_path: "That hand reached for a protected path. Scrapped.",
  secret_in_file: "Secrets do not belong in skill files. Scrapped.",
  manifest_mismatch: "Manifest and scan disagreed. Scrapped.",
  invalid_skill_name: "Bad skill name. Scrapped.",
  hash_mismatch: "Folder hash drifted. Scrapped.",
  forge_invalid: "Forge params were invalid. Hand broken.",
  test_exit_nonzero: "Test run failed. Hand broken.",
  timeout: "Skill timed out. Hand broken.",
  schema_invalid: "Test output failed schema. Hand broken.",
  charter_pin_mismatch: "Charter pin mismatch.",
  doctor_required: "I need Doctor to grow that hand — parking a capability request.",
};

export function replyFor(code: FailureCode | undefined, fallback: string): string {
  if (code && MAP[code]) return MAP[code]!;
  return fallback;
}
