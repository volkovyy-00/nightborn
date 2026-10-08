// Explorer (SPEC §9 "Recipe forge", T2): a Pi session with exactly the charter's recipe_tools
// (web_search, http_get, emit_recipe). Researches a source, then emits recipe params that code renders.
// Writes no files; every successful http_get host is recorded as *visited* for the host rules.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Job, Recipe } from "./types.ts";
import { getCharter } from "./charter.ts";
import { dataPath } from "./paths.ts";
import { createPiSession, sessionStats } from "./pi.ts";
import { hostOf, prepareRecipe, type ForgeResult } from "./forge.ts";

const BRAVE_HOST = "api.search.brave.com";
const HTTP_GET_TIMEOUT_MS = 6_000;
const HTTP_GET_MAX_BYTES = 16 * 1024; // what the model sees
const HTML_READ_MAX = 1024 * 1024; // what the host reads to build a page digest
const JSON_READ_MAX = 256 * 1024;
const HTTP_GET_MAX_HOPS = 3;
const BRAVE_MIN_GAP_MS = 1_500; // free tier ≈ 1 req/s; 1.1 s still drew 429s

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
  if (low.startsWith("::ffff:")) {
    // IPv4-mapped: dotted (from dns) or hex (WHATWG URL serialises [::ffff:127.0.0.1] as ::ffff:7f00:1)
    const rest = low.slice(7);
    if (rest.includes(".")) return privateV4(rest);
    const [hi, lo] = rest.split(":").map((h) => parseInt(h || "0", 16));
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return true;
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

function privateAddress(ip: string): boolean {
  switch (isIP(ip)) {
    case 4:
      return privateV4(ip);
    case 6:
      return privateV6(ip);
    default:
      return true;
  }
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
  return new TextDecoder("utf8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, cap));
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

// ── page digest (SPEC §9 T2): what a listing page reveals about its own data API ──

const NOISE_HOST = /(^|\.)(googleapis|googletagmanager|google-analytics|gstatic|doubleclick|facebook|sentry|hotjar)\./;
const ASSET = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)$/i;
const VOLATILE = (k: string, v: string) => /^timestamp/i.test(k) || (/^(ts|_|t|cb|.*_ts)$/i.test(k) && /^\d{10,13}$/.test(v));
const ZERO_PAGE = (k: string, v: string) => /^(limit|count|per_?page|page_?size|hitsperpage|size|rows)$/i.test(k) && v === "0";

function unescapeEmbedded(s: string): string {
  // Any escaping depth (\" or \\\" inside a JSON string inside a script) collapses to the plain character.
  return s.replace(/\\+u002[fF]/g, "/").replace(/\\+\//g, "/").replace(/\\+"/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** One JSON value starting at s[i] ('{' or '['), balanced, strings respected; null if it doesn't parse. */
function jsonAt(s: string, i: number, cap = 400_000): unknown {
  const open = s[i];
  if (open !== "{" && open !== "[") return null;
  let depth = 0;
  let inStr = false;
  for (let j = i; j < Math.min(s.length, i + cap); j++) {
    const c = s[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) {
        try {
          return JSON.parse(s.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function preview(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v) : String(v);
}

/** "results[20] · item: id: 123, name: \"…\", manufacturer_cb.seo_name: \"tesla\", …" (≤600 chars). */
function shapeOf(body: unknown): string | null {
  let best: { path: string; arr: unknown[] } | null = null;
  const walk = (v: unknown, path: string, depth: number) => {
    if (Array.isArray(v)) {
      if (v.length && v[0] && typeof v[0] === "object" && (!best || v.length > best.arr.length)) best = { path, arr: v };
      return;
    }
    if (!v || typeof v !== "object" || depth > 3) return;
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) walk(c, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(body, "", 0);
  if (!best) return null;
  const { path, arr } = best as { path: string; arr: unknown[] };
  const parts: string[] = [];
  const flat = (o: Record<string, unknown>, pre: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined || Array.isArray(v)) continue;
      if (typeof v === "object") {
        if (depth < 1) flat(v as Record<string, unknown>, `${pre}${k}.`, depth + 1);
        continue;
      }
      parts.push(`${pre}${k}: ${preview(v)}`);
    }
  };
  flat(arr[0] as Record<string, unknown>, "", 0);
  // Fields a recipe needs (names, prices, ids, links, dates) first; the rest as room allows.
  const key = /(^|\.)(id|name|title|price|url|link|slug|seo_name|date|created_at|create_date)$/i;
  const isKey = (p: string) => key.test(p.split(": ")[0]);
  let out = `${path || "(root)"}[${arr.length}] · first item: `;
  for (const p of [...parts.filter(isKey), ...parts.filter((p) => !isKey(p))]) {
    if (out.length + p.length > 600) break;
    out += p + ", ";
  }
  return out.replace(/, $/, "");
}

/** Readable query string: scalars only, volatile params dropped; null = a zero-size page (useless sample). */
function cleanQuery(params: Array<[string, string]>): string | null {
  const kept: string[] = [];
  for (const [k, v] of params) {
    if (ZERO_PAGE(k, v)) return null;
    if (VOLATILE(k, v)) continue;
    kept.push(`${k}=${encodeURIComponent(v).replace(/%3A/gi, ":").replace(/%2C/gi, ",")}`);
  }
  return kept.join("&");
}

/** SPEC §9 T2 page digest: data endpoints (+ embedded response shape), link shapes, JSON-LD, title, text. */
export function pageDigest(raw: string, pageUrl: string): string {
  const page = new URL(pageUrl);
  const u = unescapeEmbedded(raw);
  type Ep = { samples: Map<string, number>; shape: string | null };
  const eps = new Map<string, Ep>();
  const add = (origin: string, path: string, q: string | null, shape: string | null) => {
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      return;
    }
    if (!host.includes(".") || NOISE_HOST.test(host) || ASSET.test(path)) return;
    const key = origin + path;
    const ep = eps.get(key) ?? { samples: new Map<string, number>(), shape: null };
    eps.set(key, ep);
    if (q === null) return; // zero-size sample: keep the endpoint, drop the sample and its (empty) shape
    if (q) ep.samples.set(q, q.split("&").length);
    if (shape && !ep.shape) ep.shape = shape;
  };
  const re =
    /(?:(https?:\/\/[A-Za-z0-9.-]+)|(?<=["'(=]))(\/[A-Za-z0-9_\-./%]*)(\?\{[^{}]{0,800}\}|\?[^"'\s<>\\{]{1,400})?/g;
  for (const m of u.matchAll(re)) {
    let origin = m[1] ?? page.origin;
    let path = m[2];
    if (!m[1] && path.startsWith("//")) {
      const host = path.slice(2).split("/")[0];
      origin = `https://${host}`;
      path = path.slice(2 + host.length) || "/";
    }
    if (!/\/api\/|\/graphql|\/_next\/data\/|\.json$/.test(path)) continue;
    let q: string | null = "";
    const rawQ = m[3] ?? "";
    if (rawQ.startsWith("?{")) {
      try {
        const obj = JSON.parse(rawQ.slice(1)) as Record<string, unknown>;
        q = cleanQuery(Object.entries(obj).filter(([, v]) => v !== null && typeof v !== "object").map(([k, v]) => [k, String(v)]));
      } catch {
        q = "";
      }
    } else if (rawQ) {
      q = cleanQuery([...new URLSearchParams(rawQ.slice(1))]);
    }
    let shape: string | null = null;
    const end = (m.index ?? 0) + m[0].length;
    const near = u.slice(end, end + 300);
    const b = near.indexOf('"body":');
    // Only a cache key ("<url>": {...status 200, body}) carries a response; a plain URL near one does not.
    if (b >= 0 && /^"\s*:/.test(near) && !eps.get(origin + path)?.shape && /"status":\s*200/.test(near.slice(0, b))) {
      const body = jsonAt(u, end + b + 7 + (near.slice(b + 7).match(/^\s*/)?.[0].length ?? 0));
      if (body !== null) shape = shapeOf(body);
    }
    add(origin, path, q, shape);
  }
  const lines: string[] = [];
  lines.push(`page: ${(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 120)} (${page.href.slice(0, 160)})`);
  const ranked = [...eps.entries()]
    .map(([k, ep]) => ({ k, ep, score: (ep.shape ? 4 : 0) + (ep.samples.size ? 2 : 0) + (/\/api\/|graphql/.test(k) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  lines.push("", "data endpoints this page itself calls (volatile params removed):");
  if (!ranked.length) lines.push("- none found");
  for (const { k, ep } of ranked) {
    const samples = [...ep.samples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([q]) => q);
    lines.push(`- ${k}${samples.length ? "?" + samples[0] : ""}`);
    if (samples[1]) lines.push(`    also: ?${samples[1]}`);
    if (ep.shape) lines.push(`    response: ${ep.shape}`);
  }
  const groups = new Map<string, { n: number; sample: string }>();
  for (const m of raw.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let l: URL;
    try {
      l = new URL(m[1].replace(/&amp;/g, "&"), page);
    } catch {
      continue;
    }
    if (l.hostname !== page.hostname || ASSET.test(l.pathname)) continue;
    const shape = l.pathname.replace(/\d{4,}/g, "{n}");
    const g = groups.get(shape) ?? { n: 0, sample: l.href };
    g.n++;
    groups.set(shape, g);
  }
  const linkShapes = [...groups.entries()]
    .sort((a, b) => Number(b[0].includes("{n}")) - Number(a[0].includes("{n}")) || b[1].n - a[1].n)
    .slice(0, 12);
  lines.push("", "link shapes on this page (same host; {n} = digits):");
  for (const [shape, g] of linkShapes) lines.push(`- ${page.origin}${shape} ×${g.n} e.g. ${g.sample.slice(0, 160)}`);
  const ld = [...raw.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim());
  if (ld.length) {
    const types = new Map<string, number>();
    for (const b of ld) for (const t of b.matchAll(/"@type"\s*:\s*"([^"]+)"/g)) types.set(t[1], (types.get(t[1]) ?? 0) + 1);
    lines.push("", `JSON-LD: ${[...types.entries()].map(([t, n]) => `${t}×${n}`).join(", ")}`, ld[0].replace(/\s+/g, " ").slice(0, 1000));
  }
  lines.push("", "text: " + stripHtml(raw).slice(0, 2000));
  return lines.join("\n").slice(0, HTTP_GET_MAX_BYTES);
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
    const ctype = res.headers.get("content-type") ?? "";
    let raw: string;
    try {
      raw = await readCapped(res, ctype.includes("json") ? JSON_READ_MAX : HTML_READ_MAX);
    } catch {
      return { ok: false, reason: "read failed or timed out" };
    }
    let text: string;
    if (ctype.includes("json") || /^\s*[[{]/.test(raw)) {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        text = raw; // truncated JSON: hand the model what we have
      }
    } else if (ctype.includes("html") || /<html|<body|<div/i.test(raw)) {
      text = pageDigest(raw, u.href);
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

function systemPrompt(): string {
  return [
    "You are Nightborn's Explorer. You design ONE reusable, parameterised hand for the user's kind of request. You write no code: you research, then fill a recipe that code renders into a deterministic skill. The hand must serve future requests of the same kind with different values, not just this one. Nobody tells you which site to use: you find it.",
    "",
    "Tools (call them one at a time):",
    "- web_search({q, endpoint:\"news\"|\"web\"}): Brave search, ≤5 hits. Write every query in ENGLISH. When the request implies a country (e.g. prices in Kč → Czechia), name it in the query. Does NOT count as visiting a host.",
    "- http_get({url}): fetch one public https URL. JSON comes back pretty-printed (≤16 KB). An HTML page comes back as a DIGEST: \"data endpoints this page itself calls\" (the site's own JSON API URLs with their params and, when the page embeds it, the response shape: array path, length, first item's fields), \"link shapes\" (how the site links to item pages, {n} = digits), JSON-LD and a text excerpt. Every host you fetch successfully becomes an allowed host for the hand; the hand may only use hosts you fetched.",
    "- emit_recipe({...}): your final action, exactly once.",
    "",
    "Procedure (budget: 10 turns and 90 seconds in total, no retry; aim for 4–6 tool calls, one per turn):",
    "1. web_search for the leading sites of this kind in that region, e.g. \"most popular used car classifieds sites Czech Republic\". Pick the primary national marketplace (where sellers post listings, usually the biggest one), not a meta-search aggregator or a foreign site. A well-known public JSON API you already know (e.g. a site's official search API) is a fine candidate too.",
    "2. web_search the user's item together with that site's domain, e.g. \"Tesla Model 3 example.cz\". Take the listing page URL from the results. Never guess or construct page URLs yourself.",
    "3. http_get that listing page. In its digest pick the data endpoint whose response is the item list (an array of items with names/prices), and the link shape of an item page.",
    "4. Only if that endpoint's response shape is not shown in the digest: http_get the endpoint filled with the user's values.",
    "5. emit_recipe. If the page shows no usable data endpoint, try the next marketplace. For free-text topics (news, current events) emit a news recipe right away without fetching.",
    "",
    "Recipe fields:",
    "- name: short generic snake_case name for the kind of task (e.g. find_used_cars, hn_stories); never the user's value.",
    "- purpose: one sentence a router can match future requests against.",
    "- endpoint: \"json\" (preferred when a keyless public JSON API exists), else \"news\" or \"web\" (Brave search with queryPattern).",
    "- urlPattern (json only): the endpoint URL exactly as the site uses it, with the user-dependent params replaced by {input} placeholders, e.g. ...?manufacturer_model_seo={make}:{model}&limit=20. Placeholders must be input names; values are URL-encoded at run time. Never put the user's literal values in it. Drop volatile params (timestamps, session ids). Keep filters that match the ask (used ≠ new: drop or fix a param that adds new items). Ask for about 20 items.",
    "- itemsPath (json only): dot path to the array of items, e.g. \"results\" or \"data.items\"; \"\" if the response itself is the array.",
    "- map (json only): templates over ITEM fields using {field} or {nested.field} dot paths: title (required), url (required: built from the link shape and item fields, e.g. \"https://host/detail/{maker.slug}/{model.slug}/{id}\" when items have no link field, or the item's own link field like \"{url}\"; its host must be one you fetched), snippet (optional, e.g. \"{price} Kč\"), date (optional).",
    "- maxFilter (json only, optional): {field, input}. The hand drops items whose number at item field `field` is above the number input `input`. Use it for a maximum (price, mileage…) the endpoint has no param for, e.g. {\"field\":\"price\",\"input\":\"max_price\"}. Otherwise null.",
    "- queryPattern (news/web only): search string with {input} placeholders, e.g. \"{company} earnings\". site (web only): a domain appended as site:<site>, else null.",
    "- matchInput: optional input name whose value must appear in an item's title (filters off-target items, e.g. a model that isn't in the API's filter); null otherwise.",
    "- inputs (1–6): {name (snake_case), type \"string\"|\"number\", format \"text\"|\"slug\" (slug = lowercased, diacritics stripped, spaces → \"-\" before it is used in a URL), required, description}. Name inputs like the user's value keys when they fit. Numbers like prices are type number. Every required input must be used by urlPattern/queryPattern, matchInput or maxFilter.",
    "- example: the user's values keyed by input name (this is the test run).",
    "Unused fields are null.",
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
  maxFilter: Type.Optional(Type.Union([Type.Object({ field: Type.String(), input: Type.String() }), Type.Null()])),
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

/** Short "host/path" label for a step log line; "?" when the URL does not parse. */
function describeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.hostname}${u.pathname.slice(0, 40)}`;
  } catch {
    return "?";
  }
}

export type ToolText = { content: Array<{ type: "text"; text: string }>; details: Record<string, never>; terminate?: true };

/** Plain-text tool result; `terminate` ends the session (Pi terminating tool). */
export function toolText(s: string, terminate = false): ToolText {
  return { content: [{ type: "text", text: s }], details: {}, ...(terminate ? { terminate: true as const } : {}) };
}

/**
 * The research tools shared by the Explorer and the Builder (charter `recipe_tools` ∩ `code_tools`):
 * `web_search` (Brave, host-side) and `http_get` (safe GET; a 2xx adds the host to `visited`).
 * `after()` returns a result when the session is already finished (e.g. recipe emitted), else null.
 */
export function makeResearchTools(opts: { visited: string[]; step: StepLogger; after: () => ToolText | null }) {
  const { visited, step, after } = opts;
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
      if (!r.ok) return toolText(`web_search failed: ${r.reason}`);
      return toolText(JSON.stringify(r.hits));
    },
  });

  const httpGet = defineTool({
    name: "http_get",
    label: "HTTP GET",
    description: "Fetch one public https URL (6 s). JSON → pretty-printed (≤16 KB); HTML → page digest (the page's own data endpoints + response shape, link shapes). A 2xx marks its host as visited (allowed for the hand).",
    parameters: Type.Object({ url: Type.String() }),
    executionMode: "sequential",
    async execute(_id, p, signal) {
      const done = after();
      if (done) return done;
      const s0 = Date.now();
      const r = await safeHttpGet(p.url, signal);
      const where = describeUrl(p.url);
      if (!r.ok) {
        step(`explore: http_get ${where} → ${r.reason}`, Date.now() - s0);
        return toolText(`http_get failed: ${r.reason}`);
      }
      if (r.status >= 200 && r.status < 300 && !visited.includes(r.host)) visited.push(r.host);
      step(`explore: http_get ${where} ${r.status}`, Date.now() - s0);
      return toolText(`status ${r.status}\n${r.text}`);
    },
  });
  return [webSearch, httpGet];
}

/**
 * T2 recipe forge: Explorer session → recipe + visited hosts. Each tool call is reported through `step`.
 * `maxSeconds` may only tighten the charter's `recipe_max_seconds` (the fallback after a failed code forge
 * has less of the request budget left); it never loosens it.
 */
export async function exploreRecipe(job: Job, step: StepLogger, request?: string, maxSeconds?: number): Promise<ForgeResult> {
  const t0 = Date.now();
  const limits = getCharter().forge;
  const seconds = Math.max(5, Math.min(limits.recipeMaxSeconds, maxSeconds ?? limits.recipeMaxSeconds));
  const visited: string[] = [];
  let captured: Recipe | null = null;
  const text = toolText;
  const after = () => (captured ? text("recipe already emitted", true) : null);
  const [webSearch, httpGet] = makeResearchTools({ visited, step, after });

  const emit = defineTool({
    name: "emit_recipe",
    label: "Emit recipe",
    description: "Return the verified recipe. Call exactly once as your final action.",
    parameters: RecipeSchema,
    executionMode: "sequential",
    async execute(_id, p) {
      const done = after();
      if (done) return done;
      // Self-correction: everything that would end the forge in prepareRecipe throws here instead (SPEC §9 "Code then").
      if (p.endpoint === "json") {
        if (!p.urlPattern) throw new Error("json recipe needs urlPattern");
        const host = hostOf(p.urlPattern);
        if (!host) throw new Error("urlPattern must be an absolute https URL");
        if (!visited.includes(host)) throw new Error(`host ${host} was not fetched in this session: call http_get on the filled urlPattern first, then emit_recipe`);
        if (!p.map) throw new Error("json recipe needs map {title, url}");
        const mapHost = hostOf(p.map.url);
        if (mapHost && !visited.includes(mapHost)) throw new Error(`map.url host ${mapHost} was not fetched: use a host you fetched or the item's own link field`);
        if (/[?&]timestamp\w*=\d/i.test(p.urlPattern)) throw new Error("urlPattern carries a timestamp param: drop volatile params");
      } else if (!p.queryPattern) throw new Error("news/web recipe needs queryPattern");
      const dry = prepareRecipe(p as Recipe, job, visited, dataPath("skills"));
      if (!dry.ok)
        throw new Error(
          `${dry.reason}. Rules: input names match ^[a-z_]{1,24}$ (1–6 inputs); every placeholder is an input name; every required input is used by the pattern, matchInput or maxFilter; maxFilter.input is a number input; example holds a valid value for every required input; no paths, ".env" or key-like strings.`,
        );
      captured = { ...p, maxFilter: p.endpoint === "json" && p.maxFilter ? { ...p.maxFilter } : null, map: p.map ? { ...p.map } : null, inputs: p.inputs.map((i) => ({ ...i })), example: { ...p.example } };
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
  }, seconds * 1000);
  const unsub = session.subscribe((ev) => {
    if (ev.type === "turn_end" && ++turns >= limits.recipeMaxTurns && !captured) {
      limitHit = true;
      void session.abort();
    }
  });
  try {
    await session.prompt(
      `${request ? `User request: ${JSON.stringify(request.slice(0, 300))}\n` : ""}Intent: ${JSON.stringify(job.intent)}\nUser values: ${JSON.stringify(job.inputs)}\n\nFind a source (English search queries), read its page digest, then call emit_recipe once.`,
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
