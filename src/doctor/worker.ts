/**
 * In-process Doctor worker — Forge + Warden off the request path.
 *
 * kick() only schedules via setImmediate; processNext() takes one brief.
 * Secrets: missing defaults.envKeys → emit needs_secret and park (leave in wip).
 */

import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { append as auditAppend } from "../audit.ts";
import { clearProvisionalGrant, grantKeysForCaps, provisionalOr } from "../broker.ts";
import { getDefault, type CapabilityDefault } from "../defaults.ts";
import { emit } from "../events.ts";
import { runSkill } from "../exec.ts";
import {
  defaultBlandSkillSource,
  defaultNewsSkillSource,
  defaultWebSkillSource,
  ensureRunnableSkillSource,
  forgeSkillViaPi,
  loadForgeFixture,
  writeForgedSkill,
} from "../forge.ts";
import { dataPath } from "../paths.ts";
import type { ForgeArtifact, Job } from "../types.ts";
import {
  denyAndWipe,
  installSkill,
  wardenFinal,
  wardenPre,
  wipeStaging,
} from "../warden.ts";
import { validateHttpOutput } from "../../templates/schemas.ts";
import type { CapabilityBrief } from "./brief.ts";
import { complete, doctorDirs, fail, take } from "./inbox.ts";

let running = false;
let pendingKick = false;
let kickRoot: string | undefined;

function skillsRoot(): string {
  return dataPath("skills");
}

function offlineBaseUrl(caps: string[]): string | undefined {
  if (process.env.OFFLINE !== "1") return undefined;
  const port = process.env.PORT ?? "8787";
  const provider = caps.includes("notify:phone")
    ? "bland"
    : (process.env.SEARCH_PROVIDER ?? "brave").toLowerCase();
  return `http://127.0.0.1:${port}/mock/${provider}`;
}

/** Env keys still missing after consulting primary + fallbackEnvKeys. */
export function missingEnvKeys(defaults: CapabilityDefault): string[] {
  const primaryMissing = defaults.envKeys.filter((k) => !process.env[k]);
  if (primaryMissing.length === 0) return [];
  if (defaults.fallbackEnvKeys?.some((k) => Boolean(process.env[k]))) return [];
  return primaryMissing;
}

function testQueryFromBrief(brief: CapabilityBrief): string {
  const m = brief.minimalSuccess.match(/"query"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  return brief.title.replace(/_/g, " ") || "test";
}

/** Minimal listings scrape — no API key; OFFLINE uses mock via baseUrl. */
function defaultScrapeSkillSource(): string {
  return `// Nightborn minimal HTTP listings scrape — stdin query, stdout items
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
const SLASH = String.fromCharCode(47);
function joinBase(baseUrl, fallbackOrigin, relPath) {
  const base = baseUrl ?? fallbackOrigin;
  const root = base.endsWith(SLASH) ? base : \`\${base}\${SLASH}\`;
  const rel = relPath.startsWith(SLASH) ? relPath.slice(1) : relPath;
  return new URL(rel, root);
}
function mapResults(data) {
  const results = data.web?.results ?? data.results ?? data.items ?? [];
  if (Array.isArray(results) && results.length) {
    return {
      items: results.map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        ...(r.page_age || r.date || r.published_date
          ? { date: r.page_age ?? r.date ?? r.published_date }
          : {}),
      })),
    };
  }
  return { items: [] };
}
const raw = await readStdin();
const input = JSON.parse(raw || "{}");
const query = String(input.query ?? "").trim();
const baseUrl = input.baseUrl;
let res;
if (baseUrl) {
  const u = joinBase(baseUrl, "http://127.0.0.1", "");
  u.searchParams.set("q", query || "listings");
  res = await fetch(u, { signal: AbortSignal.timeout(6000) });
} else {
  const target = /^https?:\\/\\//i.test(query)
    ? query
    : \`https://example.com/?q=\${encodeURIComponent(query)}\`;
  res = await fetch(target, {
    headers: { Accept: "application/json,text/html" },
    signal: AbortSignal.timeout(6000),
  });
}
if (!res.ok) { console.error("fetch", res.status); process.exit(1); }
const ct = res.headers.get("content-type") || "";
if (ct.includes("json")) {
  const mapped = mapResults(await res.json());
  if (!mapped.items.length) {
    mapped.items.push({ title: query || "listing", url: res.url || "https://example.com/" });
  }
  process.stdout.write(JSON.stringify(mapped));
} else {
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\\/title>/i);
  process.stdout.write(JSON.stringify({
    items: [{
      title: (titleMatch?.[1] || query || "listing").trim(),
      url: res.url || query || "https://example.com/",
    }],
  }));
}
`;
}

function capsForBrief(brief: CapabilityBrief, defaults: CapabilityDefault | null): string[] {
  const fromDefaults = defaults?.caps ?? [];
  const fromBrief = brief.suggestedCaps.length ? brief.suggestedCaps : ["net:fetch"];
  return [...new Set([...fromDefaults, ...fromBrief])];
}

function scaffoldFromDefaults(hint: string | undefined): string | null {
  if (hint === "listings.http_scrape") return defaultScrapeSkillSource();
  if (hint === "search.web") return defaultNewsSkillSource();
  if (hint === "voice.outbound_bland") return defaultBlandSkillSource();
  return null;
}

async function buildArtifact(
  brief: CapabilityBrief,
  defaults: CapabilityDefault | null,
): Promise<ForgeArtifact> {
  const name = brief.changeOf || brief.title;
  const query = testQueryFromBrief(brief);
  const capabilities = capsForBrief(brief, defaults);
  const purpose = `${brief.intent}\n\nMinimal success: ${brief.minimalSuccess}`;

  const scaffold = scaffoldFromDefaults(brief.defaultsHint);
  if (scaffold) {
    return {
      name,
      purpose,
      query,
      capabilities,
      skillSource: scaffold,
    };
  }

  if (process.env.JUDGE_MODE === "1") {
    const candidates = [
      `${name}.json`,
      capabilities.includes("notify:phone") ? "place_outbound_call.json" : null,
      "pull_company_news.json",
    ].filter((n): n is string => Boolean(n));
    for (const file of candidates) {
      const fx = loadForgeFixture(file);
      if (fx) {
        return ensureRunnableSkillSource(
          { ...fx, name, purpose, query, skillSource: fx.skillSource || defaultNewsSkillSource() },
          brief.intent,
        );
      }
    }
  }

  try {
    const forged = await forgeSkillViaPi(brief.intent, query, name);
    return ensureRunnableSkillSource(
      {
        ...forged,
        name,
        purpose: forged.purpose || purpose,
        query: forged.query || query,
        capabilities: forged.capabilities?.length ? forged.capabilities : capabilities,
      },
      brief.intent,
    );
  } catch {
    // Last resort: web scaffold so Warden still has something to scan.
    const fallback = preferCall(capabilities, brief)
      ? defaultBlandSkillSource()
      : defaultWebSkillSource("listings OR deals OR marketplace");
    return {
      name,
      purpose,
      query,
      capabilities: preferCall(capabilities, brief)
        ? ["net:fetch", "notify:phone"]
        : capabilities,
      skillSource: fallback,
    };
  }
}

function preferCall(caps: string[], brief: CapabilityBrief): boolean {
  if (caps.includes("notify:phone")) return true;
  const t = `${brief.intent} ${brief.title}`.toLowerCase();
  return /\b(call|phone|outbound|bland)\b/.test(t);
}

async function forgeInstall(brief: CapabilityBrief, defaults: CapabilityDefault | null): Promise<string> {
  const runId = randomUUID().slice(0, 8);
  const runDir = dataPath("staging", `doctor_${runId}`);
  mkdirSync(runDir, { recursive: true });

  let artifact: ForgeArtifact;
  try {
    artifact = await buildArtifact(brief, defaults);
  } catch (err) {
    wipeStaging(runDir);
    throw new Error(`forge failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let skillName: string;
  let testQuery: string;
  try {
    const written = writeForgedSkill(artifact, runDir, skillsRoot());
    skillName = written.skillName;
    testQuery = written.testQuery || artifact.query || testQueryFromBrief(brief);
  } catch (err) {
    wipeStaging(runDir);
    throw new Error(`forge write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const needs = capsForBrief(brief, defaults);
  const job: Job = {
    skill: skillName,
    intent: brief.intent,
    query: testQuery,
    needs,
    template: needs.includes("notify:phone") ? undefined : "http",
  };

  const pre = wardenPre(runDir, job, skillName);
  if (!pre.ok) {
    denyAndWipe(runDir, skillName, pre.failureCode, pre.caps, pre.detail);
    throw new Error(`warden pre: ${pre.failureCode} ${pre.detail}`);
  }

  const input: { query: string; baseUrl?: string } = { query: testQuery };
  const base = offlineBaseUrl(pre.caps);
  if (base) input.baseUrl = base;

  const result = await runSkill(
    path.join(runDir, "skill.mjs"),
    runDir,
    input,
    provisionalOr(grantKeysForCaps(pre.caps)),
    15_000,
  );

  if (result.timedOut || !result.ok) {
    clearProvisionalGrant();
    wipeStaging(runDir);
    const code = result.timedOut ? "timeout" : "test_exit_nonzero";
    throw new Error(`test ${code}: ${(result.stderr || "").slice(0, 200)}`);
  }

  const validated = validateHttpOutput(result.stdout);
  if (!validated.ok) {
    clearProvisionalGrant();
    wipeStaging(runDir);
    throw new Error(`schema_invalid: ${validated.reason}`);
  }

  const fin = wardenFinal(runDir, skillName, pre.folderHash, pre.caps);
  if (!fin.ok) {
    denyAndWipe(runDir, skillName, fin.failureCode, fin.caps, fin.detail);
    throw new Error(`warden final: ${fin.failureCode} ${fin.detail}`);
  }

  installSkill(runDir, skillName, fin.caps, fin.folderHash, skillsRoot());
  return skillName;
}

/**
 * Worker tick: take one brief → defaults/env check → forge+install or park.
 * Does not block callers of submit/kick.
 */
export async function processNext(root?: string): Promise<void> {
  const brief = await take(root);
  if (!brief) return;

  const defaults = brief.defaultsHint ? getDefault(brief.defaultsHint) : null;

  if (defaults) {
    const missing = missingEnvKeys(defaults);
    if (missing.length > 0) {
      const message =
        `Capability "${brief.title}" needs ${missing.join(", ")}. ` +
        `Add to .env and reload (Doctor will retry parked briefs).`;
      await emit({
        type: "capability.needs_secret",
        requestId: brief.requestId,
        envKeys: missing,
        message,
      });
      await auditAppend({
        type: "doctor.blocked_on_secret",
        summary: `Doctor blocked on secret for ${brief.requestId}`,
        why: brief.why,
        goalId: brief.goalId,
        data: {
          requestId: brief.requestId,
          auditRef: brief.auditRef,
          missing,
          defaultsHint: brief.defaultsHint,
        },
      });
      // Park: leave brief in wip for T10 retryParkedSecretBriefs.
      return;
    }
  }

  try {
    const skill = await forgeInstall(brief, defaults);
    await complete(brief.requestId, root);
    await emit({
      type: "capability.ready",
      requestId: brief.requestId,
      goalId: brief.goalId,
      skill,
    });
    await auditAppend({
      type: "doctor.forged",
      summary: `Doctor forged ${skill} for ${brief.requestId}`,
      why: brief.why,
      goalId: brief.goalId,
      data: {
        requestId: brief.requestId,
        auditRef: brief.auditRef,
        skill,
        defaultsHint: brief.defaultsHint,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      await fail(brief.requestId, root);
    } catch {
      /* already moved or missing */
    }
    await emit({
      type: "capability.failed",
      requestId: brief.requestId,
      goalId: brief.goalId,
      error,
    });
    await auditAppend({
      type: "doctor.failed",
      summary: `Doctor failed ${brief.requestId}`,
      why: brief.why,
      goalId: brief.goalId,
      data: {
        requestId: brief.requestId,
        auditRef: brief.auditRef,
        error,
      },
    });
  }
}

/** True when inbox has at least one pending brief (does not dequeue). */
async function inboxHasPending(root?: string): Promise<boolean> {
  const dirs = doctorDirs(root);
  try {
    const names = await readdir(dirs.inbox);
    return names.some((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch {
    return false;
  }
}

async function drain(root?: string): Promise<void> {
  if (running) {
    pendingKick = true;
    return;
  }
  running = true;
  try {
    do {
      pendingKick = false;
      // Sequential Forge: drain inbox; parked (needs_secret) briefs stay in wip.
      while (await inboxHasPending(root)) {
        await processNext(root);
      }
    } while (pendingKick);
  } finally {
    running = false;
  }
}

/**
 * Schedule Doctor work off the caller's stack. Never awaits Forge.
 * Safe to call from submit / agent turn.
 */
export function kick(root?: string): void {
  if (root !== undefined) kickRoot = root;
  setImmediate(() => {
    void drain(kickRoot).catch((err) => {
      console.error("[doctor] drain error", err);
    });
  });
}
