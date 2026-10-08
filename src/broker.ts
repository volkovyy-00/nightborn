// Broker: holds the keys; a skill child gets only env names the Warden decided (SPEC §9 "Broker").
import type { Cap } from "./types.ts";

/** The only key a hand can ever get (`llm:call` is denied by the charter). */
export const BROKER_MAP: Record<string, Cap> = { BRAVE_API_KEY: "net:fetch" };

/** Values for the granted names: only Broker-mapped names set in process.env; `{}` when OFFLINE=1. */
export function brokerGrant(envNames: string[]): Record<string, string> {
  if (process.env.OFFLINE === "1") return {};
  const grant: Record<string, string> = {};
  for (const name of envNames) {
    if (!Object.hasOwn(BROKER_MAP, name)) continue;
    const value = process.env[name];
    if (value) grant[name] = value;
  }
  return grant;
}

// PRE provisional grant, held in memory for the Test of one run.
const provisional = new Map<string, string[]>();

export function setProvisionalGrant(runId: string, envNames: string[]): void {
  provisional.set(runId, envNames.filter((n) => Object.hasOwn(BROKER_MAP, n)));
}

export function getProvisionalGrant(runId: string): string[] {
  return [...(provisional.get(runId) ?? [])];
}

export function clearProvisionalGrant(runId: string): void {
  provisional.delete(runId);
}
