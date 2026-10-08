import { readFileSync } from "node:fs";
import { charterHashFromBytes, shortHash } from "./hash.ts";
import { dataPath } from "./paths.ts";

/** Machine-read charter: only the four fenced blocks, by info string (SPEC §6). */
export type Charter = {
  capsAllow: string[];
  capsDeny: string[];
  neverHosts: string[];
  forge: {
    recipeTools: string[];
    recipeMaxTurns: number;
    recipeMaxSeconds: number;
    codeTools: string[];
    codeMaxTurns: number;
    codeMaxSeconds: number;
    codeMaxTestRuns: number;
  };
};

const BLOCKS = ["caps-allow", "caps-deny", "never-hosts", "forge"] as const;

function fencedBlock(text: string, info: string): string[] {
  const re = new RegExp("^```" + info + "[ \\t]*\\n([\\s\\S]*?)^```[ \\t]*$", "gm");
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1) throw new Error(`charter: expected one \`${info}\` block, found ${hits.length}`);
  return hits[0][1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function parseCharter(text: string): Charter {
  const [allow, deny, never, forgeLines] = BLOCKS.map((b) => fencedBlock(text, b));
  const kv = new Map<string, string>();
  for (const line of forgeLines) {
    const m = line.match(/^([a-z_]+):\s*(.+)$/);
    if (!m) throw new Error(`charter: bad forge line`);
    kv.set(m[1], m[2].trim());
  }
  const num = (k: string): number => {
    const n = Number(kv.get(k));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`charter: forge ${k} missing`);
    return n;
  };
  const list = (k: string): string[] => {
    const v = kv.get(k);
    if (!v) throw new Error(`charter: forge ${k} missing`);
    return v.split(/\s+/);
  };
  const overlap = allow.filter((c) => deny.includes(c));
  if (overlap.length) throw new Error(`charter: caps both allowed and denied`);
  return {
    capsAllow: allow,
    capsDeny: deny,
    neverHosts: never,
    forge: {
      recipeTools: list("recipe_tools"),
      recipeMaxTurns: num("recipe_max_turns"),
      recipeMaxSeconds: num("recipe_max_seconds"),
      codeTools: list("code_tools"),
      codeMaxTurns: num("code_max_turns"),
      codeMaxSeconds: num("code_max_seconds"),
      codeMaxTestRuns: num("code_max_test_runs"),
    },
  };
}

let bootHash: string | null = null;
let charter: Charter | null = null;

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
  charter = parseCharter(bytes.toString("utf8"));
  bootHash = computed;
  return computed;
}

export function getCharter(): Charter {
  if (!charter) throw new Error("charter not loaded");
  return charter;
}

export function getCharterHash(): string {
  if (!bootHash) throw new Error("charter not loaded");
  return bootHash;
}

export function displayCharterHash(): string {
  return shortHash(getCharterHash());
}

/** Allowed = in caps-allow and not in caps-deny. Anything else → capability_not_allowed. */
export function isAllowedCap(cap: string): boolean {
  const c = getCharter();
  return c.capsAllow.includes(cap) && !c.capsDeny.includes(cap);
}

/** caps-allow ∪ caps-deny: the literal set Talk may declare as `needs` (SPEC §10). */
export function allCaps(): string[] {
  const c = getCharter();
  return [...c.capsAllow, ...c.capsDeny];
}

/** Derived alias kept for v3 call sites until Runner/Talk v4 land. */
export const ALLOWED_CAPS: readonly string[] = new Proxy([] as string[], {
  get(_t, k) {
    const arr = getCharter().capsAllow;
    const v = Reflect.get(arr, k);
    return typeof v === "function" ? v.bind(arr) : v;
  },
});
