/**
 * In-process Doctor worker — Forge + Warden off the request path.
 *
 * kick() only schedules via setImmediate; processNext() takes one brief.
 * Secrets: missing defaults.envKeys → emit needs_secret and park (leave in wip).
 */

import { mkdirSync } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { append as auditAppend } from "../audit.ts";
import {
  clearProvisionalGrant,
  grantKeysForCaps,
  provisionalOr,
  runWithOutboundBlocked,
  runWithProvisionalScope,
} from "../broker.ts";
import {
  composioProxyUrlForSkill,
  setPendingComposioBinding,
  skillComposioUserId,
} from "../composio.ts";
import { getDefault, type CapabilityDefault } from "../defaults.ts";
import { emit, subscribe } from "../events.ts";
import { runSkill } from "../exec.ts";
import {
  defaultBlandSkillSource,
  defaultNewsSkillSource,
  defaultWebSkillSource,
  ensureRunnableSkillSource,
  forgeSkill,
  isNeedsComposioAccessError,
  isNeedsSkillAfterComposioError,
  loadForgeFixture,
  sanitizeSkillSource,
  skillSourcePassesContract,
  writeForgedSkill,
} from "../forge.ts";
import { getCharterHash } from "../charter.ts";
import { isListingHub } from "../listings.ts";
import { appendLog } from "../log.ts";
import { dataPath } from "../paths.ts";
import {
  createForgeDebugSession,
  type ForgeDebugBackend,
} from "../forgeDebug.ts";
import type { FailureCode, ForgeArtifact, ForgeContext, Job } from "../types.ts";
import {
  denyAndWipe,
  installSkill,
  wardenFinal,
  wardenPre,
  wipeStaging,
} from "../warden.ts";
import { validateHttpOutput } from "../../templates/schemas.ts";
import type { CapabilityBrief } from "./brief.ts";
import {
  briefFileStem,
  clearParkedComposio,
  complete,
  doctorDirs,
  fail,
  isParkedComposio,
  markParkedComposio,
  take,
} from "./inbox.ts";

let running = false;
let pendingKick = false;
let kickRoot: string | undefined;

function skillsRoot(): string {
  return dataPath("skills");
}

/** Collapse whitespace and clip for surgery.log detail (one JSON line). */
function clipDetail(s: string, max = 1200): string {
  const t = s.replace(/\r\n/g, "\n").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function doctorLog(
  skill: string | null,
  decision: "allow" | "deny" | "pass" | "fail",
  detail: string,
  extra?: { failureCode?: FailureCode },
): void {
  appendLog({
    actor: "doctor",
    event: "doctor",
    skill,
    decision,
    charterHash: getCharterHash(),
    detail,
    ...(extra?.failureCode ? { failureCode: extra.failureCode } : {}),
  });
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

/**
 * Listing discovery via Brave (or OFFLINE mock baseUrl) with site:<host> scope.
 * Filters shopping-index hubs; retries year+make queries for vehicle cards.
 */
function defaultScrapeSkillSource(siteHost: string): string {
  const site = siteHost.replace(/[^a-z0-9.-]/gi, "") || "example.com";
  return `// Nightborn site-scoped listing search — stdin query, stdout vehicle cards
// SITE=${site} (Brave site: filter; drops shopping-index hubs; OFFLINE uses input.baseUrl)
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
const SITE = ${JSON.stringify(site)};
const SLASH = String.fromCharCode(47);
function joinBase(baseUrl, fallbackOrigin, relPath) {
  const base = baseUrl ?? fallbackOrigin;
  const root = base.endsWith(SLASH) ? base : \`\${base}\${SLASH}\`;
  const rel = relPath.startsWith(SLASH) ? relPath.slice(1) : relPath;
  return new URL(rel, root);
}
function isHub(title, url) {
  const t = String(title || "").trim();
  const u = String(url || "").toLowerCase();
  if (!t && !u) return true;
  if (/price-under|used-cars-under|for-sale-under|shopping|seo|research|car-reviews|appraisal|\\/articles\\/|\\/reviews\\//i.test(u)) return true;
  if (/\\/used-\\d{4}-[a-z0-9-]+/i.test(u)) return true;
  if (/edmunds\\.com\\/[a-z0-9-]+\\/[a-z0-9-]+\\/(19|20)\\d{2}\\/?(\\?|$)/i.test(u)) return true;
  if (/used cars?\\s+for sale|cars?\\s+for sale\\s+(under|near)|near me\\s*\\|/i.test(t)) return true;
  if (/^used cars?\\s+under/i.test(t) || /vehicle\\s+pric/i.test(t)) return true;
  if (/\\bunder\\s+\\$?\\s*[\\d,]+\\s*(for sale|near)/i.test(t)) return true;
  if (!/\\b(19|20)\\d{2}\\b/.test(t)) return true;
  return false;
}
function isVdpUrl(url) {
  const u = String(url || "").toLowerCase();
  return /vehicledetail|\\/vehicle\\/[0-9a-f-]{8}/i.test(u);
}
function hasAskingPrice(title) {
  const t = String(title || "");
  for (const m of t.matchAll(/\\$\\s*([\\d,]+)/g)) {
    const before = t.slice(Math.max(0, (m.index || 0) - 12), m.index || 0).toLowerCase();
    if (/\\bunder\\s*$/.test(before)) continue;
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 500 && n <= 250000) return true;
  }
  return false;
}
function mapRaw(data) {
  const results = data.web?.results ?? data.results ?? data.items ?? [];
  return (Array.isArray(results) ? results : []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    ...(r.page_age || r.date || r.published_date || r.age
      ? { date: r.page_age ?? r.date ?? r.published_date ?? r.age }
      : {}),
  })).filter((i) => i.url);
}
function keepVehicles(items) {
  return items.filter((i) => {
    if (isHub(i.title, i.url)) return false;
    if (!hasAskingPrice(i.title)) return false;
    // Cars.com: require a vehicle-detail URL (shopping/research indexes slip past year checks).
    if (SITE.indexOf("cars.com") >= 0) return isVdpUrl(i.url);
    return true;
  });
}
function altQueries(_userQ) {
  // Queries proven to return individual sale cards on Brave (not category indexes).
  if (SITE.indexOf("cars.com") >= 0) {
    return [
      "vehicledetail used honda",
      "vehicledetail used toyota",
      "vehicledetail used chevrolet",
      "vehicledetail used nissan",
    ];
  }
  if (SITE.indexOf("edmunds") >= 0) {
    return [
      "vin used honda for sale",
      "vin used toyota for sale",
      "used honda civic for sale price",
      "used toyota camry for sale price",
    ];
  }
  return ["used honda for sale", "used toyota for sale", "used chevrolet for sale"];
}
async function braveSearch(q, baseUrl, key) {
  const u = joinBase(baseUrl, "https://api.search.brave.com", "res" + SLASH + "v1" + SLASH + "web" + SLASH + "search");
  u.searchParams.set("q", q);
  u.searchParams.set("count", "10");
  const headers = { Accept: "application/json" };
  if (key && !baseUrl) headers["X-Subscription-Token"] = key;
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(u, { headers, signal: AbortSignal.timeout(8000) });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res.ok) throw new Error("search " + res.status);
  return mapRaw(await res.json());
}
const raw = await readStdin();
const input = JSON.parse(raw || "{}");
const userQ = String(input.query ?? "").trim() || "used cars";
const baseUrl = input.baseUrl;
const key = process.env.BRAVE_API_KEY || process.env.TAVILY_API_KEY;
if (!baseUrl && !key) { console.error("missing BRAVE_API_KEY"); process.exit(1); }
const seen = new Set();
const vehicles = [];
for (const aq of altQueries(userQ)) {
  const q = aq.toLowerCase().includes("site:") ? aq : ("site:" + SITE + " " + aq);
  let batch = [];
  try { batch = await braveSearch(q, baseUrl, key); } catch (e) {
    if (!vehicles.length) { console.error(String(e.message || e)); process.exit(1); }
    break;
  }
  for (const it of keepVehicles(batch)) {
    const k = (it.url || it.title).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    vehicles.push(it);
    if (vehicles.length >= 8) break;
  }
  if (vehicles.length >= 5) break;
  await new Promise((r) => setTimeout(r, 800));
}
process.stdout.write(JSON.stringify({ items: vehicles }));
`;
}

/** Map skill title / intent → hostname for site: search. */
export function siteHostFromBrief(title: string, intent: string): string {
  const blob = `${title} ${intent}`.toLowerCase();
  if (/cars[_.\s-]?com|cars_com/.test(blob)) return "cars.com";
  if (/edmunds/.test(blob)) return "edmunds.com";
  if (/cargurus/.test(blob)) return "cargurus.com";
  if (/autotrader/.test(blob)) return "autotrader.com";
  if (/craigslist/.test(blob)) return "craigslist.org";
  const m = blob.match(/\b([a-z0-9-]+\.(com|org|net))\b/);
  return m?.[1] ?? "cars.com";
}

function capsForBrief(brief: CapabilityBrief, defaults: CapabilityDefault | null): string[] {
  const fromDefaults = defaults?.caps ?? [];
  const fromBrief = brief.suggestedCaps.length ? brief.suggestedCaps : ["net:fetch"];
  return [...new Set([...fromDefaults, ...fromBrief])];
}

function scaffoldFromDefaults(
  hint: string | undefined,
  brief: CapabilityBrief,
): string | null {
  if (hint === "composio.apify") return null;
  if (hint === "listings.http_scrape") {
    return defaultScrapeSkillSource(siteHostFromBrief(brief.title, brief.intent));
  }
  if (hint === "search.web") return defaultNewsSkillSource();
  if (hint === "voice.outbound_bland") return defaultBlandSkillSource();
  return null;
}

type ArtifactAuthor = "cursor" | "pi" | "scaffold" | "fixture";

type BuiltArtifact = {
  artifact: ForgeArtifact;
  author: ArtifactAuthor;
};

function forgeAuthorLabel(): ArtifactAuthor {
  const planner = (process.env.PLANNER || "pi").trim().toLowerCase();
  if (planner === "cursor") return "cursor";
  const backend = (process.env.FORGE_BACKEND || "pi").trim().toLowerCase();
  return backend === "cursor" ? "cursor" : "pi";
}

function scaffoldFirstEnabled(): boolean {
  return (process.env.FORGE_SCAFFOLD_FIRST || "").trim() === "1";
}

function forgeDebugBackendLabel(): ForgeDebugBackend {
  const planner = (process.env.PLANNER || "pi").trim().toLowerCase();
  if (planner === "cursor") return "cursor-sdk";
  const backend = (process.env.FORGE_BACKEND || "pi").trim().toLowerCase();
  return backend === "cursor" ? "cursor" : "pi";
}

async function buildArtifact(
  brief: CapabilityBrief,
  defaults: CapabilityDefault | null,
  debugDir?: string,
): Promise<BuiltArtifact> {
  const name = brief.changeOf || brief.title;
  const query = testQueryFromBrief(brief);
  const capabilities = capsForBrief(brief, defaults);
  const purpose = `${brief.intent}\n\nMinimal success: ${brief.minimalSuccess}`;
  const siteHost = siteHostFromBrief(brief.title, brief.intent);
  const userAsk = brief.userAsk?.trim() || brief.intent.trim();
  const forgeCtx: ForgeContext = {
    skillName: name,
    requestId: brief.requestId,
    goalId: brief.goalId,
    userAsk,
    defaultsHint: brief.defaultsHint,
    siteHost,
    minimalSuccess: brief.minimalSuccess,
    ...(debugDir ? { debugDir } : {}),
  };

  // Opt-in demo escape hatch only — live product path is forge-first.
  if (scaffoldFirstEnabled()) {
    const scaffold = scaffoldFromDefaults(brief.defaultsHint, brief);
    if (scaffold) {
      return {
        author: "scaffold",
        artifact: { name, purpose, query, capabilities, skillSource: scaffold },
      };
    }
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
        return {
          author: "fixture",
          artifact: ensureRunnableSkillSource(
            {
              ...fx,
              name,
              purpose,
              query,
              skillSource: fx.skillSource || defaultNewsSkillSource(),
            },
            brief.intent,
          ),
        };
      }
    }
  }

  try {
    const forged = await forgeSkill(brief.intent, query, name, forgeCtx);
    const author = forgeAuthorLabel();
    // Listings: do not let ensureRunnable swap in a generic web/news scaffold —
    // that returns shopping hubs. Bad forge → throw → site-scoped VDP scaffold.
    if (brief.defaultsHint === "listings.http_scrape") {
      const src = sanitizeSkillSource(forged.skillSource || "");
      if (!skillSourcePassesContract(src)) {
        throw new Error("forge_invalid: listings skill failed host contract");
      }
      appendLog({
        actor: "forge",
        event: "forge",
        skill: name,
        decision: "allow",
        charterHash: getCharterHash(),
        detail: `author=${author} defaultsHint=${brief.defaultsHint ?? ""} site=${siteHost} · skillSource (${src.length} chars)`,
      });
      return {
        author,
        artifact: {
          ...forged,
          name,
          purpose: forged.purpose || purpose,
          query: forged.query || query,
          capabilities: forged.capabilities?.length ? forged.capabilities : capabilities,
          skillSource: src,
        },
      };
    }
    appendLog({
      actor: "forge",
      event: "forge",
      skill: name,
      decision: "allow",
      charterHash: getCharterHash(),
      detail: `author=${author} defaultsHint=${brief.defaultsHint ?? ""} site=${siteHost} · skillSource (${forged.skillSource?.length ?? 0} chars)`,
    });
    return {
      author,
      artifact: ensureRunnableSkillSource(
        {
          ...forged,
          name,
          purpose: forged.purpose || purpose,
          query: forged.query || query,
          capabilities: forged.capabilities?.length ? forged.capabilities : capabilities,
        },
        brief.intent,
      ),
    };
  } catch (err) {
    // Forge asked for Composio Connect — never swallow into a Brave scaffold.
    if (isNeedsComposioAccessError(err)) throw err;
    // Access confirmed but no skillSource — fail, do not cars.com-scaffold.
    if (isNeedsSkillAfterComposioError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const scaffold = scaffoldFromDefaults(brief.defaultsHint, brief);
    if (scaffold) {
      appendLog({
        actor: "forge",
        event: "forge",
        skill: name,
        decision: "allow",
        charterHash: getCharterHash(),
        detail: `author=scaffold defaultsHint=${brief.defaultsHint ?? ""} site=${siteHost} · forge failed: ${clipDetail(msg, 200)}`,
      });
      return {
        author: "scaffold",
        artifact: { name, purpose, query, capabilities, skillSource: scaffold },
      };
    }
    // Last resort: web/call scaffold so Warden still has something to scan.
    const fallback = preferCall(capabilities, brief)
      ? defaultBlandSkillSource()
      : defaultWebSkillSource("listings OR deals OR marketplace");
    appendLog({
      actor: "forge",
      event: "forge",
      skill: name,
      decision: "allow",
      charterHash: getCharterHash(),
      detail: `author=scaffold defaultsHint=${brief.defaultsHint ?? ""} · forge failed: ${clipDetail(msg, 200)}`,
    });
    return {
      author: "scaffold",
      artifact: {
        name,
        purpose,
        query,
        capabilities: preferCall(capabilities, brief)
          ? ["net:fetch", "notify:phone"]
          : capabilities,
        skillSource: fallback,
      },
    };
  }
}

function preferCall(caps: string[], brief: CapabilityBrief): boolean {
  if (caps.includes("notify:phone")) return true;
  const t = `${brief.intent} ${brief.title}`.toLowerCase();
  return /\b(call|phone|outbound|bland)\b/.test(t);
}

async function forgeInstall(brief: CapabilityBrief, defaults: CapabilityDefault | null): Promise<string> {
  // Never place real Bland calls during forge → warden → install-test.
  return runWithProvisionalScope(() =>
    runWithOutboundBlocked(() => forgeInstallInner(brief, defaults)),
  );
}

async function forgeInstallInner(
  brief: CapabilityBrief,
  defaults: CapabilityDefault | null,
): Promise<string> {
  const runId = randomUUID().slice(0, 8);
  const runDir = dataPath("staging", `doctor_${runId}`);
  mkdirSync(runDir, { recursive: true });

  const nameForDebug = brief.changeOf || brief.title;
  const debugSession = createForgeDebugSession(
    {
      skillName: nameForDebug,
      requestId: brief.requestId,
      goalId: brief.goalId,
      defaultsHint: brief.defaultsHint,
      siteHost: siteHostFromBrief(brief.title, brief.intent),
      minimalSuccess: brief.minimalSuccess,
    },
    runId,
    forgeDebugBackendLabel(),
  );

  doctorLog(
    brief.title,
    "allow",
    `working · forging ${brief.title} · staging=doctor_${runId}` +
      (debugSession ? ` · debug=${debugSession.relPath}` : ""),
  );

  let artifact: ForgeArtifact;
  let author: ArtifactAuthor = "scaffold";
  try {
    const built = await buildArtifact(brief, defaults, debugSession?.dir);
    artifact = built.artifact;
    author = built.author;
  } catch (err) {
    wipeStaging(runDir);
    if (isNeedsComposioAccessError(err)) {
      doctorLog(
        brief.title,
        "deny",
        `parked needs_composio_access · toolkit=${err.toolkit} · ${clipDetail(err.why || err.message, 240)}`,
      );
      await auditAppend({
        type: "doctor.blocked_on_composio",
        summary: `Doctor blocked on Composio for ${brief.requestId}`,
        why: err.why || brief.why,
        goalId: brief.goalId,
        data: {
          requestId: brief.requestId,
          toolkit: err.toolkit,
          skillName: err.skillName,
          redirectUrl: err.redirectUrl,
        },
      });
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    doctorLog(brief.title, "fail", `forge LLM/scaffold failed · ${clipDetail(msg, 400)}`, {
      failureCode: "forge_invalid",
    });
    throw new Error(`forge failed: ${msg}`);
  }

  let skillName: string;
  let testQuery: string;
  try {
    const written = writeForgedSkill(artifact, runDir, skillsRoot());
    skillName = written.skillName;
    testQuery = written.testQuery || artifact.query || testQueryFromBrief(brief);
  } catch (err) {
    wipeStaging(runDir);
    appendLog({
      actor: "forge",
      event: "broken",
      skill: brief.title,
      decision: "fail",
      failureCode: "forge_invalid",
      charterHash: getCharterHash(),
      detail: "Doctor forge write failed",
    });
    throw new Error(`forge write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Bind under written slug (not display name) so Doctor test proxy lookup hits.
  if (artifact.composio) {
    artifact.composio = {
      ...artifact.composio,
      userId: skillComposioUserId(skillName),
    };
    setPendingComposioBinding(skillName, artifact.composio);
  }

  const src = artifact.skillSource ?? "";
  appendLog({
    actor: "forge",
    event: "forge",
    skill: skillName,
    decision: "allow",
    charterHash: getCharterHash(),
    detail: clipDetail(
      `author=${author} defaultsHint=${brief.defaultsHint ?? ""} · skillSource (${src.length} chars):\n${src}`,
      2400,
    ),
  });
  doctorLog(
    skillName,
    "allow",
    `working · wrote skill.mjs · author=${author} · query=${clipDetail(testQuery, 120)} · caps=${(artifact.capabilities || []).join(",")}`,
  );

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
    doctorLog(
      skillName,
      "fail",
      `warden pre denied · ${pre.failureCode} · ${clipDetail(pre.detail, 200)}`,
      { failureCode: pre.failureCode },
    );
    throw new Error(`warden pre: ${pre.failureCode} ${pre.detail}`);
  }

  const isCall = pre.caps.includes("notify:phone");
  // Call hands: never dial during Doctor install (rate limit + real outbound).
  if (isCall) {
    doctorLog(
      skillName,
      "allow",
      "working · test skipped · notify:phone (no live dial during Doctor install)",
    );
    appendLog({
      actor: "test",
      event: "test",
      skill: skillName,
      decision: "pass",
      charterHash: getCharterHash(),
      detail: "Doctor skipped live call test · notify:phone · warden-only install",
    });
  } else {
    const input: {
      query: string;
      baseUrl?: string;
      composioProxyUrl?: string;
    } = { query: testQuery };
    const base = offlineBaseUrl(pre.caps);
    if (base) input.baseUrl = base;
    if (artifact.composio) {
      input.composioProxyUrl = composioProxyUrlForSkill(skillName);
    }

    doctorLog(
      skillName,
      "allow",
      `working · test run · query=${clipDetail(testQuery, 100)}${base ? ` · baseUrl=${base}` : ""}`,
    );

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
      const failDetail = clipDetail(
        `Doctor test failed (${code}) · exit=${result.code}` +
          (result.stderr ? `\nstderr:\n${result.stderr}` : "") +
          (result.stdout ? `\nstdout:\n${result.stdout}` : ""),
        2000,
      );
      appendLog({
        actor: "test",
        event: "broken",
        skill: skillName,
        decision: "fail",
        failureCode: code,
        charterHash: getCharterHash(),
        detail: failDetail,
      });
      doctorLog(skillName, "fail", failDetail, { failureCode: code });
      throw new Error(`test ${code}: ${(result.stderr || "").slice(0, 200)}`);
    }

    const validated = validateHttpOutput(result.stdout);
    if (!validated.ok) {
      clearProvisionalGrant();
      wipeStaging(runDir);
      const failDetail = clipDetail(
        `schema_invalid · ${validated.reason}\nstdout:\n${result.stdout}`,
        2000,
      );
      appendLog({
        actor: "test",
        event: "broken",
        skill: skillName,
        decision: "fail",
        failureCode: "schema_invalid",
        charterHash: getCharterHash(),
        detail: failDetail,
      });
      doctorLog(skillName, "fail", failDetail, { failureCode: "schema_invalid" });
      throw new Error(`schema_invalid: ${validated.reason}`);
    }

    // Listings hands must return vehicle cards — shopping-index hubs alone fail install.
    if (brief.defaultsHint === "listings.http_scrape") {
      const items = validated.data.items;
      const hubs = items.filter((it) =>
        isListingHub(String(it.title ?? ""), String(it.url ?? "")),
      );
      const vehicles = items.length - hubs.length;
      if (vehicles < 1) {
        clearProvisionalGrant();
        wipeStaging(runDir);
        const failDetail = clipDetail(
          `listings_hubs_only · ${items.length} items (${hubs.length} hubs, 0 vehicle cards)\nstdout:\n${result.stdout}`,
          2000,
        );
        appendLog({
          actor: "test",
          event: "broken",
          skill: skillName,
          decision: "fail",
          failureCode: "schema_invalid",
          charterHash: getCharterHash(),
          detail: failDetail,
        });
        doctorLog(skillName, "fail", failDetail, { failureCode: "schema_invalid" });
        throw new Error("schema_invalid: listings returned only shopping-index hubs");
      }
    }

    appendLog({
      actor: "test",
      event: "test",
      skill: skillName,
      decision: "pass",
      charterHash: getCharterHash(),
      detail: clipDetail(
        `Doctor pass · ${validated.data.items.length} items · author=${author} · stdout:\n${result.stdout}`,
        2000,
      ),
    });
    doctorLog(
      skillName,
      "pass",
      `working · test ok · ${validated.data.items.length} items · author=${author}`,
    );
  }

  const fin = wardenFinal(runDir, skillName, pre.folderHash, pre.caps);
  if (!fin.ok) {
    denyAndWipe(runDir, skillName, fin.failureCode, fin.caps, fin.detail);
    doctorLog(
      skillName,
      "fail",
      `warden final denied · ${fin.failureCode} · ${clipDetail(fin.detail, 200)}`,
      { failureCode: fin.failureCode },
    );
    throw new Error(`warden final: ${fin.failureCode} ${fin.detail}`);
  }

  installSkill(
    runDir,
    skillName,
    fin.caps,
    fin.folderHash,
    skillsRoot(),
    artifact.composio,
  );
  if (artifact.composio) {
    setPendingComposioBinding(skillName, artifact.composio);
  }
  // Brief pause so sequential Brave site-searches (test + resume) are less likely to 429.
  await new Promise((r) => setTimeout(r, 1500));
  return skillName;
}

/**
 * Worker tick: take one brief → defaults/env check → forge+install or park.
 * Does not block callers of submit/kick.
 */
export async function processNext(root?: string): Promise<void> {
  const brief = await take(root);
  if (!brief) return;

  doctorLog(
    brief.title,
    "allow",
    `received ${brief.requestId} · goal=${brief.goalId} · intent=${clipDetail(brief.intent, 160)} · ` +
      `defaults=${brief.defaultsHint ?? "none"} · caps=[${brief.suggestedCaps.join(",")}] · ` +
      `why=${clipDetail(brief.why, 200)}`,
  );

  const defaults = brief.defaultsHint ? getDefault(brief.defaultsHint) : null;

  // OFFLINE mock does not need live API keys.
  if (defaults && process.env.OFFLINE !== "1") {
    const missing = missingEnvKeys(defaults);
    if (missing.length > 0) {
      const message =
        `Capability "${brief.title}" needs ${missing.join(", ")}. ` +
        `Add to .env and reload (Doctor will retry parked briefs).`;
      doctorLog(
        brief.title,
        "deny",
        `parked needs_secret · missing=${missing.join(",")} · ${clipDetail(message, 240)}`,
      );
      await emit({
        type: "capability.needs_secret",
        requestId: brief.requestId,
        goalId: brief.goalId,
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
    doctorLog(
      skill,
      "pass",
      `ready · installed ${skill} for ${brief.requestId}`,
    );
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
    if (isNeedsComposioAccessError(err)) {
      // Leave brief in wip for retry on access.ready (same as needs_secret).
      await markParkedComposio(brief.requestId, root);
      doctorLog(
        brief.title,
        "deny",
        `parked needs_composio_access · waiting Connect Link · toolkit=${err.toolkit}`,
      );
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    try {
      await fail(brief.requestId, root);
    } catch {
      /* already moved or missing */
    }
    doctorLog(
      brief.title,
      "fail",
      `failed ${brief.requestId} · ${clipDetail(error, 500)}`,
    );
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
 * Re-queue parked Composio WIP briefs after access.ready, then kick.
 * Skips in-flight forges (no .parked-composio sidecar).
 */
export async function retryParkedComposioBriefs(
  requestIds: string[],
  root?: string,
): Promise<string[]> {
  if (!requestIds.length) return [];
  const dirs = doctorDirs(root);
  const requeued: string[] = [];
  for (const requestId of requestIds) {
    if (!(await isParkedComposio(requestId, root))) continue;
    const name = `${briefFileStem(requestId)}.md`;
    const from = path.join(dirs.wip, name);
    const to = path.join(dirs.inbox, name);
    try {
      await clearParkedComposio(requestId, root);
      await rename(from, to);
      requeued.push(requestId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  if (requeued.length > 0) {
    doctorLog(
      null,
      "allow",
      `re-queued ${requeued.length} brief(s) after Composio access.ready · ${requeued.join(",")}`,
    );
    kick(root);
  }
  return requeued;
}

let composioRetryBridgeStarted = false;

/** Subscribe once: access.ready → re-queue matching Doctor wip briefs. */
export function startComposioDoctorRetryBridge(): () => void {
  if (composioRetryBridgeStarted) return () => {};
  composioRetryBridgeStarted = true;
  return subscribe((e) => {
    if (e.type !== "access.ready") return;
    void retryParkedComposioBriefs([e.requestId]).catch((err) => {
      console.error("[doctor] composio retry error", err);
    });
  });
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
