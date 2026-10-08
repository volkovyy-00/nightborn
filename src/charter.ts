import { readFileSync } from "node:fs";
import { charterHashFromBytes, shortHash } from "./hash.ts";
import { dataPath } from "./paths.ts";

export const ALLOWED_CAPS = ["net:fetch", "llm:call", "fs:read_own", "notify:phone"] as const;
export const DENIED_CAPS = [
  "notify:email",
  "budget:write",
  "charter:write",
  "secrets:read",
  "fs:write_own",
] as const;

let bootHash: string | null = null;

export function loadAndPinCharter(): string {
  const bytes = readFileSync(dataPath("charter.md"));
  const computed = charterHashFromBytes(bytes);
  const pin = process.env.CHARTER_PIN?.trim();
  if (!pin) {
    throw new Error("CHARTER_PIN missing from env");
  }
  if (computed !== pin) {
    const err = new Error("charter_pin_mismatch");
    (err as Error & { computed: string }).computed = computed;
    throw err;
  }
  // Verify fenced allow-list contains expected caps
  const text = bytes.toString("utf8");
  const fence = text.match(/```\n([\s\S]*?)```/);
  if (!fence) throw new Error("charter.md missing capability fenced block");
  const listed = new Set(
    fence[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  for (const cap of ALLOWED_CAPS) {
    if (!listed.has(cap)) throw new Error(`charter allow-list missing ${cap}`);
  }
  bootHash = computed;
  return computed;
}

export function getCharterHash(): string {
  if (!bootHash) throw new Error("charter not loaded");
  return bootHash;
}

export function displayCharterHash(): string {
  return shortHash(getCharterHash());
}

export function isAllowedCap(cap: string): boolean {
  return (ALLOWED_CAPS as readonly string[]).includes(cap);
}
