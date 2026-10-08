/** Broker holds secrets; grants only allow-listed env keys into skill subprocess. */

const KEYS = [
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "APIFY_TOKEN",
  "BLAND_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export type GrantKey = (typeof KEYS)[number];

let provisional: GrantKey[] | null = null;

export function setProvisionalGrant(keys: GrantKey[]): void {
  provisional = keys;
}

export function clearProvisionalGrant(): void {
  provisional = null;
}

export function searchEnvKey(): GrantKey {
  const p = (process.env.SEARCH_PROVIDER ?? "brave").toLowerCase();
  if (p === "tavily") return "TAVILY_API_KEY";
  return "BRAVE_API_KEY";
}

/** Keys to grant for a set of required capabilities (PRE / Install). */
export function grantKeysForCaps(caps: string[]): GrantKey[] {
  if (caps.includes("notify:phone")) return ["BLAND_API_KEY"];
  return [searchEnvKey()];
}

export function buildChildEnv(allowed: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
  };
  if (process.platform === "win32") {
    env.SYSTEMROOT = process.env.SYSTEMROOT;
  }
  for (const k of allowed) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export function provisionalOr(decisionEnv: string[]): string[] {
  if (provisional) return [...provisional];
  return decisionEnv;
}
