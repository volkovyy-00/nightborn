/** Broker holds secrets; grants only allow-listed env keys into skill subprocess. */

import { AsyncLocalStorage } from "node:async_hooks";

const KEYS = [
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "APIFY_TOKEN",
  "BLAND_API_KEY",
  "BLAND_DEMO_PHONE_NUMBER",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export type GrantKey = (typeof KEYS)[number];

type ProvisionalStore = { keys: GrantKey[] | null };

const provisionalAls = new AsyncLocalStorage<ProvisionalStore>();
/** When true, child skill envs omit Bland keys and set NIGHTBORN_BLOCK_OUTBOUND=1. */
const outboundBlockedAls = new AsyncLocalStorage<boolean>();

/** Process-global fallback when not inside runWithProvisionalScope (legacy sync paths). */
let provisionalGlobal: GrantKey[] | null = null;

/**
 * Run forge/test/install (or any Warden path) with an isolated provisional grant slot.
 * Nested calls nest ALS stores; set/clear only touch the current store.
 */
export function runWithProvisionalScope<T>(fn: () => T): T;
export function runWithProvisionalScope<T>(fn: () => Promise<T>): Promise<T>;
export function runWithProvisionalScope<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return provisionalAls.run({ keys: null }, fn);
}

/**
 * Forge/Doctor/Create install tests must never place real Bland calls.
 * Live Reuse must NOT wrap with this.
 */
export function runWithOutboundBlocked<T>(fn: () => T): T;
export function runWithOutboundBlocked<T>(fn: () => Promise<T>): Promise<T>;
export function runWithOutboundBlocked<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return outboundBlockedAls.run(true, fn);
}

export function isOutboundBlocked(): boolean {
  return outboundBlockedAls.getStore() === true;
}

export function setProvisionalGrant(keys: GrantKey[]): void {
  const store = provisionalAls.getStore();
  if (store) store.keys = keys;
  else provisionalGlobal = keys;
}

export function clearProvisionalGrant(): void {
  const store = provisionalAls.getStore();
  if (store) store.keys = null;
  else provisionalGlobal = null;
}

export function searchEnvKey(): GrantKey {
  const p = (process.env.SEARCH_PROVIDER ?? "brave").toLowerCase();
  if (p === "tavily") return "TAVILY_API_KEY";
  return "BRAVE_API_KEY";
}

/** Keys to grant for a set of required capabilities (PRE / Install). */
export function grantKeysForCaps(caps: string[]): GrantKey[] {
  if (caps.includes("notify:phone")) return ["BLAND_API_KEY", "BLAND_DEMO_PHONE_NUMBER"];
  return [searchEnvKey()];
}

export function buildChildEnv(allowed: string[]): NodeJS.ProcessEnv {
  const blocked = isOutboundBlocked();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
  };
  if (process.platform === "win32") {
    env.SYSTEMROOT = process.env.SYSTEMROOT;
  }
  if (blocked) {
    env.NIGHTBORN_BLOCK_OUTBOUND = "1";
  }
  for (const k of allowed) {
    if (blocked && (k === "BLAND_API_KEY" || k === "BLAND_DEMO_PHONE_NUMBER")) {
      continue;
    }
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export function provisionalOr(decisionEnv: string[]): string[] {
  const store = provisionalAls.getStore();
  const provisional = store ? store.keys : provisionalGlobal;
  if (provisional) return [...provisional];
  return decisionEnv;
}
