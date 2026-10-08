// Explorer (SPEC §9 "Recipe forge", T2): a Pi session with exactly the charter's recipe_tools
// (web_search, http_get, emit_recipe). Researches a source, then emits recipe params that code renders.
// Writes no files; every successful http_get host is recorded as *visited* for the host rules.
import { existsSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Job, Recipe } from "./types.ts";
import { getCharter } from "./charter.ts";
import { repoPath } from "./paths.ts";
import { createPiSession, sessionStats } from "./pi.ts";
import type { ForgeResult } from "./forge.ts";

const BRAVE_HOST = "api.search.brave.com";
const HTTP_GET_TIMEOUT_MS = 6_000;
const HTTP_GET_MAX_BYTES = 16 * 1024;
const HTTP_GET_MAX_HOPS = 3;
const BRAVE_MIN_GAP_MS = 1_100; // free tier ≈ 1 req/s

export type StepLogger = (detail: string, ms?: number) => void;

// ── http_get safety ───────────────────────────────────────────────────────

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  );
}

function privateV6(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === "::" || low === "::1") return true;
  if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // link-local
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique local
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return false;
}

function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? privateV4(ip) : v === 6 ? privateV6(ip) : true;
}

/** https only · host ∉ never-hosts · no private / loopback / link-local address (literal or DNS-resolved). */
async function checkHost(u: URL): Promise<string | null> {
  if (u.protocol !== "https:") return "https only";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) return "no host";
  if (getCharter().neverHosts.includes(host)) return "host is on the charter's never-hosts list";
  if (isIP(host)) return privateAddress(host) ? "private address" : null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return "private host";
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return "unresolvable host";
    if (addrs.some((a) => privateAddress(a.address))) return "host resolves to a private address";
  } catch {
    return "unresolvable host";
  }
  return null;
}

async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  const all = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, all.length - off);
    if (n <= 0) break;
    all.set(c.subarray(0, n), off);
    off += n;
  }
  return new TextDecoder("utf8", { fatal: false }).decode(all);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export type HttpGetResult = { ok: true; host: string; status: number; text: string } | { ok: false; reason: string };

/** Host-side GET for the Explorer: 6 s, ≤16 KB, manual redirects with every hop re-checked (SPEC §9). */
export async function safeHttpGet(rawUrl: string, signal?: AbortSignal): Promise<HttpGetResult> {
  let u: URL;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  for (let hop = 0; hop <= HTTP_GET_MAX_HOPS; hop++) {
    const bad = await checkHost(u);
    if (bad) return { ok: false, reason: bad };
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(HTTP_GET_TIMEOUT_MS);
      res = await fetch(u, {
        redirect: "manual",
        headers: { Accept: "application/json, text/html;q=0.9, */*;q=0.1", "User-Agent": "Mozilla/5.0 (compatible; Nightborn/0.1)" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      return { ok: false, reason: "fetch failed or timed out" };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      if (!loc) return { ok: false, reason: `redirect ${res.status} without location` };
      try {
        u = new URL(loc, u);
      } catch {
        return { ok: false, reason: "bad redirect" };
      }
      continue;
    }
    const raw = await readCapped(res, HTTP_GET_MAX_BYTES);
    const ctype = res.headers.get("content-type") ?? "";
    let text: string;
    if (ctype.includes("json") || /^\s*[[{]/.test(raw)) {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        text = raw; // truncated JSON: hand the model what we have
      }
    } else if (ctype.includes("html") || /<html|<body|<div/i.test(raw)) {
      text = stripHtml(raw);
    } else {
      text = raw;
    }
    return { ok: true, host: u.hostname, status: res.status, text: text.slice(0, HTTP_GET_MAX_BYTES) };
  }
  return { ok: false, reason: "too many redirects" };
}

// ── web_search (Brave, host-side) ─────────────────────────────────────────

let lastBraveAt = 0;
async function braveThrottle(): Promise<void> {
  const wait = lastBraveAt + BRAVE_MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastBraveAt = Date.now();
}

export type SearchHit = { title: string; url: string; snippet: string };

export async function braveSearch(q: string, endpoint: "news" | "web", signal?: AbortSignal): Promise<{ ok: true; hits: SearchHit[] } | { ok: false; reason: string }> {
  const key = process.env.BRAVE_API_KEY?.trim();
  if (!key) return { ok: false, reason: "search unavailable" };
  await braveThrottle();
  const u = new URL(endpoint === "news" ? `https://${BRAVE_HOST}/res/v1/news/search` : `https://${BRAVE_HOST}/res/v1/web/search`);
  u.searchParams.set("q", q);
  u.searchParams.set("count", "5");
  if (endpoint === "news") u.searchParams.set("freshness", "pw");
  try {
    const timeout = AbortSignal.timeout(HTTP_GET_TIMEOUT_MS);
    const res = await fetch(u, { headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) return { ok: false, reason: `search http ${res.status}` };
    const data = (await res.json()) as { results?: unknown[]; web?: { results?: unknown[] } };
    const raw = (endpoint === "news" ? data.results : data.web?.results) ?? [];
    const hits = (Array.isArray(raw) ? raw : []).slice(0, 5).map((r) => {
      const o = r as { title?: unknown; url?: unknown; description?: unknown };
      return { title: String(o.title ?? ""), url: String(o.url ?? ""), snippet: String(o.description ?? "").slice(0, 300) };
    });
    return { ok: true, hits };
  } catch {
    return { ok: false, reason: "search failed or timed out" };
  }
}

// ── Explorer session ──────────────────────────────────────────────────────

function sourcesHints(): string {
  const p = repoPath("sources.md");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "(no sources.md)";
}

function systemPrompt(): string {
  return [
    "You are Nightborn's Explorer. You design ONE reusable, parameterised hand for the user's kind of request. You write no code: you research, then fill a recipe that code renders into a deterministic skill. The hand must serve future requests of the same kind with different values, not just this one.",
    "",
    "Tools (call them one at a time):",
    "- web_search({q, endpoint:\"news\"|\"web\"}): Brave search, ≤5 hits. Use it to find a public JSON API or to confirm a site. Does NOT count as visiting a host.",
    "- http_get({url}): fetch one public https URL (≤16 KB, JSON pretty-printed, HTML stripped). Every host you fetch successfully becomes an allowed host for the hand. The hand may only use hosts you fetched.",
    "- emit_recipe({...}): your final action, exactly once. The recipe must be fully verified: for a json recipe you MUST have fetched the filled urlPattern (with the user's values) via http_get in this session and seen the items array.",
    "",
    "Recipe fields:",
    "- name: short generic snake_case name for the kind of task (e.g. find_used_cars, hn_stories); never the user's value.",
    "- purpose: one sentence a router can match future requests against.",
    "- endpoint: \"json\" (preferred when a keyless public JSON API exists), else \"news\" or \"web\" (Brave search with queryPattern).",
    "- urlPattern (json only): absolute https URL with {input} placeholders, e.g. https://host/api?make={make}&max={max_price}. Placeholders must be input names; values are URL-encoded at run time. Never put the user's literal values in it.",
    "- itemsPath (json only): dot path to the array of items in the response, e.g. \"results\" or \"data.items\"; \"\" if the response itself is the array.",
    "- map (json only): templates over ITEM fields using {field} or {nested.field} dot paths: title (required), url (required: an absolute https link built from item fields, e.g. \"https://host/detail/{id}\"; its host must also be one you fetched, or use the item's own link field like \"{url}\"), snippet (optional, e.g. \"{price} Kč\"), date (optional).",
    "- queryPattern (news/web only): search string with {input} placeholders, e.g. \"{company} earnings\". site (web only): a domain appended as site:<site>, else null.",
    "- matchInput: optional input name whose value must appear in an item's title (filters off-target items, e.g. a wrong model slug returning the whole make); null otherwise.",
    "- inputs (1–6): {name (snake_case), type \"string\"|\"number\", format \"text\"|\"slug\" (slug = lowercased, diacritics stripped, spaces → \"-\" before it is used in a URL), required, description}. Name inputs like the user's value keys when they fit. Numbers like prices are type number.",
    "- example: the user's values keyed by input name (this is the test run).",
    "",
    "Budget: at most 6 turns and 60 seconds, no retry. Unused fields are null.",
    "",
    "Procedure:",
    "1. Read the source hints below FIRST. If a hint covers the user's kind of request, do NOT web_search: http_get the hint's URL filled with the user's values (slugs lowercased, diacritics stripped, spaces → -), confirm the items array, then emit_recipe with that urlPattern.",
    "2. Otherwise: one web_search for a public JSON API, http_get the most promising URL filled with the user's values, then emit_recipe. If a fetch returns 404 or no items, do not guess more paths: fall back to a news/web recipe.",
    "",
    "# Source hints (curated)",
    sourcesHints(),
  ].join("\n");
}

const RecipeSchema = Type.Object({
  name: Type.String(),
  purpose: Type.String(),
  endpoint: Type.Union([Type.Literal("news"), Type.Literal("web"), Type.Literal("json")]),
  queryPattern: Type.Union([Type.String(), Type.Null()]),
  site: Type.Union([Type.String(), Type.Null()]),
  urlPattern: Type.Union([Type.String(), Type.Null()]),
  itemsPath: Type.Union([Type.String(), Type.Null()]),
  matchInput: Type.Union([Type.String(), Type.Null()]),
  map: Type.Union([
    Type.Object({
      title: Type.String(),
      url: Type.String(),
      snippet: Type.Union([Type.String(), Type.Null()]),
      date: Type.Union([Type.String(), Type.Null()]),
    }),
    Type.Null(),
  ]),
  inputs: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.Union([Type.Literal("string"), Type.Literal("number")]),
      format: Type.Union([Type.Literal("text"), Type.Literal("slug")]),
      required: Type.Boolean(),
      description: Type.String(),
    }),
  ),
  example: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
});

function hostOf(pattern: string): string | null {
  try {
    const url = new URL(pattern.replace(/\{[^{}]+\}/g, "x"));
    return url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

/** T2 recipe forge: Explorer session → recipe + visited hosts. Each tool call is reported through `step`. */
export async function exploreRecipe(job: Job, step: StepLogger): Promise<ForgeResult> {
  const t0 = Date.now();
  const limits = getCharter().forge;
  const visited: string[] = [];
  let captured: Recipe | null = null;
  const text = (s: string, terminate = false) => ({ content: [{ type: "text" as const, text: s }], details: {}, ...(terminate ? { terminate: true } : {}) });
  const after = () => (captured ? text("recipe already emitted", true) : null);

  const webSearch = defineTool({
    name: "web_search",
    label: "Web search",
    description: "Brave search (news or web), up to 5 hits {title,url,snippet}. Does not visit a host.",
    parameters: Type.Object({ q: Type.String(), endpoint: Type.Union([Type.Literal("news"), Type.Literal("web")]) }),
    executionMode: "sequential",
    async execute(_id, p, signal) {
      const done = after();
      if (done) return done;
      const s0 = Date.now();
      const r = await braveSearch(p.q, p.endpoint, signal);
      step(`explore: web_search "${p.q.slice(0, 60)}" → ${r.ok ? `${r.hits.length} hits` : r.reason}`, Date.now() - s0);
      if (!r.ok) return text(`web_search failed: ${r.reason}`);
      return text(JSON.stringify(r.hits));
    },
  });

  const httpGet = defineTool({
    name: "http_get",
    label: "HTTP GET",
    description: "Fetch one public https URL (6 s, ≤16 KB). A 2xx marks its host as visited (allowed for the hand).",
    parameters: Type.Object({ url: Type.String() }),
    executionMode: "sequential",
    async execute(_id, p, signal) {
      const done = after();
      if (done) return done;
      const s0 = Date.now();
      const r = await safeHttpGet(p.url, signal);
      const where = (() => {
        try {
          const u = new URL(p.url);
          return `${u.hostname}${u.pathname.slice(0, 40)}`;
        } catch {
          return "?";
        }
      })();
      if (!r.ok) {
        step(`explore: http_get ${where} → ${r.reason}`, Date.now() - s0);
        return text(`http_get failed: ${r.reason}`);
      }
      if (r.status >= 200 && r.status < 300 && !visited.includes(r.host)) visited.push(r.host);
      step(`explore: http_get ${where} ${r.status}`, Date.now() - s0);
      return text(`status ${r.status}\n${r.text}`);
    },
  });

  const emit = defineTool({
    name: "emit_recipe",
    label: "Emit recipe",
    description: "Return the verified recipe. Call exactly once as your final action.",
    parameters: RecipeSchema,
    executionMode: "sequential",
    async execute(_id, p) {
      const done = after();
      if (done) return done;
      // Cheap self-correction checks (the full checks run in prepareRecipe, SPEC §9 "Code then").
      const names = new Set(p.inputs.map((i) => i.name));
      if (p.endpoint === "json") {
        if (!p.urlPattern) throw new Error("json recipe needs urlPattern");
        const host = hostOf(p.urlPattern);
        if (!host) throw new Error("urlPattern must be an absolute https URL");
        if (!visited.includes(host)) throw new Error(`host ${host} was not fetched in this session: call http_get on the filled urlPattern first, then emit_recipe`);
        const mapHost = p.map ? hostOf(p.map.url) : null;
        if (p.map && mapHost && !visited.includes(mapHost)) throw new Error(`map.url host ${mapHost} was not fetched: use a host you fetched or the item's own link field`);
        if (!p.map) throw new Error("json recipe needs map {title, url}");
        for (const m of p.urlPattern.matchAll(/\{([^{}]+)\}/g)) if (!names.has(m[1])) throw new Error(`urlPattern placeholder {${m[1]}} is not an input name`);
      } else {
        if (!p.queryPattern) throw new Error("news/web recipe needs queryPattern");
        for (const m of p.queryPattern.matchAll(/\{([^{}]+)\}/g)) if (!names.has(m[1])) throw new Error(`queryPattern placeholder {${m[1]}} is not an input name`);
      }
      captured = { ...p, map: p.map ? { ...p.map } : null, inputs: p.inputs.map((i) => ({ ...i })), example: { ...p.example } };
      step(`explore: emit_recipe ${p.endpoint} ${p.name}`);
      return text("recipe received", true);
    },
  });

  let session: Awaited<ReturnType<typeof createPiSession>>;
  try {
    session = await createPiSession({ role: "forge", systemPrompt: systemPrompt(), customTools: [webSearch, httpGet, emit] });
  } catch {
    return { ok: false, reason: "explorer: session failed", tokens: 0, costUsd: 0, ms: Date.now() - t0, source: "live" };
  }
  let limitHit = false;
  let turns = 0;
  const timer = setTimeout(() => {
    if (captured) return;
    limitHit = true;
    void session.abort();
  }, limits.recipeMaxSeconds * 1000);
  const unsub = session.subscribe((ev) => {
    if (ev.type === "turn_end" && ++turns >= limits.recipeMaxTurns && !captured) {
      limitHit = true;
      void session.abort();
    }
  });
  try {
    await session.prompt(
      `Intent: ${JSON.stringify(job.intent)}\nUser values: ${JSON.stringify(job.inputs)}\n\nCheck the source hints first. http_get the real URL filled with these values, then call emit_recipe once.`,
    );
  } catch {
    /* no recipe → forge_invalid below */
  } finally {
    clearTimeout(timer);
    unsub();
  }
  const { tokens, costUsd } = sessionStats(session);
  session.dispose();
  const ms = Date.now() - t0;
  if (!captured) {
    return { ok: false, reason: limitHit ? "explorer: limit" : "explorer: no emit_recipe", tokens, costUsd, ms, source: "live" };
  }
  return { ok: true, recipe: captured, visited, tokens, costUsd, ms, source: "live" };
}
