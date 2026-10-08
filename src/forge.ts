import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ForgeFixture, Input, InputValues, Job, Manifest, Recipe, RenderedRecipe } from "./types.ts";
import { repoPath } from "./paths.ts";
import { listSkillDirs } from "./hash.ts";
import { getCharter } from "./charter.ts";
import { PROTECTED, SECRET } from "./warden.ts";
import { createPiSession, sessionStats } from "./pi.ts";

const BRAVE_HOST = "api.search.brave.com";
const NAME_RE = /^[a-z0-9_]{1,40}$/;
const INPUT_NAME_RE = /^[a-z_]{1,24}$/;

export type ForgeResult =
  | { ok: true; recipe: Recipe; visited: string[]; tokens: number; costUsd: number; ms: number; source: "live" | "fixture" }
  | { ok: false; reason: string; tokens: number; costUsd: number; ms: number; source: "live" | "fixture" };

export type PreparedHand = { name: string; manifest: Manifest; testInputs: InputValues };

// ── Fixtures (OFFLINE / judge path) ─────────────────────────────────────

export function normaliseText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** SPEC §9 OFFLINE: chosen by `job.skill`, else by normalised intent (`match` keywords). */
export function findForgeFixture(job: Job): ForgeFixture | null {
  const dir = repoPath("fixtures", "forge");
  if (!existsSync(dir)) return null;
  if (job.skill) {
    const p = path.join(dir, `${job.skill}.json`);
    if (NAME_RE.test(job.skill) && existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as ForgeFixture;
  }
  const intent = normaliseText(job.intent);
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as ForgeFixture;
    if (Array.isArray(fx.match) && fx.match.some((k) => intent.includes(normaliseText(k)))) return fx;
  }
  return null;
}

// ── T1 recipe forge: one-shot Pi call, terminating `emit_recipe` ────────

const T1_SYSTEM = [
  "You design a reusable news-search hand. You write no code: you fill a recipe that code renders.",
  "The hand searches recent news for one free-text input named `query`.",
  "Call `emit_recipe` exactly once, then stop.",
  "- name: short generic snake_case name for the kind of task (e.g. company_news), never containing the user's value.",
  "- purpose: one sentence a router can match future requests against.",
  "- queryPattern: the search string with the `{query}` placeholder, e.g. \"{query}\" or \"{query} news\".",
  "- example: {\"query\": <the user's value>}.",
].join("\n");

export async function forgeRecipeT1(job: Job): Promise<ForgeResult> {
  const t0 = Date.now();
  const limits = getCharter().forge;
  let captured: Recipe | null = null;

  const emit = defineTool({
    name: "emit_recipe",
    label: "Emit Recipe",
    description: "Return the recipe for a news-search hand. Call exactly once as your final action.",
    parameters: Type.Object({
      name: Type.String(),
      purpose: Type.String(),
      queryPattern: Type.String(),
      example: Type.Object({ query: Type.String() }),
    }),
    async execute(_id, p) {
      // T1: endpoint forced to news, single input {query} (SPEC §9 "Recipe forge").
      captured = {
        name: p.name,
        purpose: p.purpose,
        endpoint: "news",
        queryPattern: p.queryPattern,
        site: null,
        urlPattern: null,
        itemsPath: null,
        matchInput: null,
        map: null,
        inputs: [
          { name: "query", type: "string", format: "text", required: true, description: "Company or topic name, as the user wrote it" },
        ],
        example: { query: p.example.query },
      };
      return { content: [{ type: "text", text: "recipe received" }], details: {}, terminate: true };
    },
  });

  let session: Awaited<ReturnType<typeof createPiSession>>;
  try {
    session = await createPiSession({ role: "forge", systemPrompt: T1_SYSTEM, customTools: [emit] });
  } catch {
    return { ok: false, reason: "recipe: session failed", tokens: 0, costUsd: 0, ms: Date.now() - t0, source: "live" };
  }
  let limitHit = false;
  let turns = 0;
  const timer = setTimeout(() => {
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
      `Intent: ${JSON.stringify(job.intent)}\nUser values: ${JSON.stringify(job.inputs)}\nCall emit_recipe now.`,
    );
  } catch {
    /* handled below: no recipe → forge_invalid */
  } finally {
    clearTimeout(timer);
    unsub();
  }
  const { tokens, costUsd } = sessionStats(session);
  session.dispose();
  const ms = Date.now() - t0;
  if (!captured) {
    return { ok: false, reason: limitHit ? "forge: limit" : "recipe: no emit_recipe", tokens, costUsd, ms, source: "live" };
  }
  return { ok: true, recipe: captured, visited: [], tokens, costUsd, ms, source: "live" };
}

/** OFFLINE / fixture forge: replay `fixtures/forge/*.json` (SPEC §9 "OFFLINE mode"). */
export function forgeFromFixture(job: Job): ForgeResult {
  const fx = findForgeFixture(job);
  if (!fx) return { ok: false, reason: "offline: no forge fixture", tokens: 0, costUsd: 0, ms: 0, source: "fixture" };
  return { ok: true, recipe: fx.recipe, visited: fx.visited ?? [], tokens: 0, costUsd: 0, ms: 0, source: "fixture" };
}

// ── Code checks + render (no LLM; SPEC §9 "Code then: …") ───────────────

function slugifyName(s: string): string {
  let n = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!n) n = "hand";
  return n.slice(0, 40).replace(/_+$/, "");
}

function uniqueName(base: string, skillsRoot: string): string {
  const taken = new Set(listSkillDirs(skillsRoot));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const cand = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!taken.has(cand)) return cand;
  }
}

function placeholders(pattern: string | null): string[] {
  if (!pattern) return [];
  return [...pattern.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
}

function hostOf(u: string): string | null {
  try {
    const url = new URL(u.replace(/\{[^{}]+\}/g, "x"));
    return url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

/** Coerce + validate values against inputs: required present, numbers coerced, unknown keys dropped. */
export function coerceInputs(inputs: Input[], values: InputValues): InputValues | null {
  const out: InputValues = {};
  for (const inp of inputs) {
    const raw = values[inp.name];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      if (inp.required) return null;
      continue;
    }
    if (inp.type === "number") {
      if (typeof raw === "number") {
        if (!Number.isFinite(raw)) return null;
        out[inp.name] = raw;
        continue;
      }
      // "1 000 000 Kč" → 1000000 (spaces, currency, thousands separators stripped)
      const digits = String(raw).replace(/[\s  ]/g, "").replace(/[^0-9.,-]/g, "").replace(/[.,](?=\d{3}(\D|$))/g, "");
      if (!/\d/.test(digits)) return null; // "abc", "Kč", "unlimited" → invalid, never 0
      const n = Number(digits.replace(",", "."));
      if (!Number.isFinite(n)) return null;
      out[inp.name] = n;
    } else {
      out[inp.name] = String(raw).trim();
    }
  }
  return out;
}

export function prepareRecipe(
  recipe: Recipe,
  job: Job,
  visited: string[],
  skillsRoot: string,
): { ok: true; hand: PreparedHand } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!["news", "web", "json"].includes(recipe.endpoint)) return fail("recipe: bad endpoint");
  const json = recipe.endpoint === "json";
  if (!Array.isArray(recipe.inputs) || recipe.inputs.length === 0 || recipe.inputs.length > 6) return fail("recipe: inputs");
  for (const i of recipe.inputs) {
    if (!INPUT_NAME_RE.test(i.name)) return fail("recipe: input name");
    if (!["string", "number"].includes(i.type) || !["text", "slug"].includes(i.format)) return fail("recipe: input type");
  }
  const names = new Set(recipe.inputs.map((i) => i.name));
  if (json) {
    // json: urlPattern (absolute https) + itemsPath ("" = root, leading "/" stripped) + map{title,url}
    recipe = { ...recipe, queryPattern: null, site: null, itemsPath: String(recipe.itemsPath ?? "").replace(/^\/+/, "") };
    if (!recipe.urlPattern || !hostOf(recipe.urlPattern)) return fail("recipe: urlPattern");
    if (!recipe.map || typeof recipe.map.title !== "string" || typeof recipe.map.url !== "string") return fail("recipe: map");
    recipe.map = { title: recipe.map.title, url: recipe.map.url, snippet: recipe.map.snippet || null, date: recipe.map.date || null };
  } else {
    recipe = { ...recipe, urlPattern: null, itemsPath: null, map: null, site: recipe.endpoint === "web" ? recipe.site : null };
    if (!recipe.queryPattern) return fail("recipe: no queryPattern");
  }
  const used = [...placeholders(recipe.queryPattern), ...placeholders(recipe.urlPattern)];
  for (const p of used) if (!names.has(p)) return fail(`recipe: unknown placeholder {${p}}`);
  for (const i of recipe.inputs) if (i.required && !used.includes(i.name)) return fail(`recipe: unused input ${i.name}`);
  if (recipe.matchInput && !names.has(recipe.matchInput)) return fail("recipe: matchInput");
  const example = coerceInputs(recipe.inputs, recipe.example ?? {});
  if (!example) return fail("recipe: example");

  // Forge-time literal check (SPEC §9, §18 #13): every string rendered into skill.mjs vs the Warden's frozen regexes.
  const rendered = [
    recipe.queryPattern, recipe.site, recipe.urlPattern, recipe.itemsPath, recipe.matchInput,
    ...(recipe.map ? [recipe.map.title, recipe.map.url, recipe.map.snippet, recipe.map.date] : []),
    ...recipe.inputs.map((i) => i.name),
  ].filter((s): s is string => typeof s === "string");
  if (rendered.some((s) => PROTECTED.test(s))) return fail("recipe: protected literal");
  if (rendered.some((s) => SECRET.test(s))) return fail("recipe: key-like literal");

  // hosts: Brave for news/web; urlPattern + map.url hosts for json (SPEC §9). Non-Brave hosts must be visited.
  const hosts = json
    ? [...new Set([hostOf(recipe.urlPattern!), hostOf(recipe.map!.url)].filter((h): h is string => !!h))]
    : [BRAVE_HOST];
  const never = getCharter().neverHosts;
  if (hosts.some((h) => never.includes(h))) return fail("recipe: never-host");
  const unvisited = hosts.find((h) => h !== BRAVE_HOST && !visited.includes(h));
  if (unvisited) return fail(`recipe: host not visited ${unvisited}`);

  const base = slugifyName(job.skill && job.skill.trim() ? job.skill : recipe.name);
  const name = uniqueName(base, skillsRoot);
  if (!NAME_RE.test(name)) return fail("recipe: name");

  const manifest: Manifest = {
    name,
    kind: "recipe",
    purpose: String(recipe.purpose ?? "").slice(0, 200),
    inputs: recipe.inputs.map((i) => ({
      name: i.name,
      type: i.type,
      format: i.format,
      required: Boolean(i.required),
      description: String(i.description ?? "").slice(0, 120),
    })),
    capabilities: ["net:fetch"],
    hosts,
    recipe: { ...recipe, name },
  };
  const testInputs = coerceInputs(manifest.inputs, job.inputs) ?? example;
  return { ok: true, hand: { name, manifest, testInputs } };
}

/** Render templates/recipe/ into runDir via JSON.stringify only (function replacers: no `$&` expansion). */
export function renderRecipe(hand: PreparedHand, runDir: string): void {
  mkdirSync(runDir, { recursive: true });
  const tpl = (f: string) => readFileSync(repoPath("templates", "recipe", f), "utf8");
  const r = hand.manifest.recipe!;
  const rendered: RenderedRecipe = {
    endpoint: r.endpoint,
    queryPattern: r.queryPattern,
    site: r.site,
    urlPattern: r.urlPattern,
    itemsPath: r.itemsPath,
    map: r.map,
    matchInput: r.matchInput,
    inputs: hand.manifest.inputs.map((i) => ({ name: i.name, type: i.type, format: i.format })),
  };
  const variant = r.endpoint === "json" ? "skill.json.mjs.tpl" : "skill.search.mjs.tpl";
  writeFileSync(path.join(runDir, "skill.mjs"), tpl(variant).replace("__RECIPE_JSON__", () => JSON.stringify(rendered)));
  writeFileSync(
    path.join(runDir, "manifest.json"),
    tpl("manifest.json.tpl").replace("__MANIFEST_JSON__", () => JSON.stringify(hand.manifest, null, 2)),
  );
  const inputsText = hand.manifest.inputs.map((i) => `${i.name}:${i.type}`).join(", ");
  const notes = tpl("notes.md.tpl")
    .replace(/__NAME__/g, () => hand.name)
    .replace(/__PURPOSE__/g, () => hand.manifest.purpose)
    .replace(/__ENDPOINT__/g, () => r.endpoint)
    .replace(/__INPUTS__/g, () => inputsText)
    .replace(/__HOSTS__/g, () => hand.manifest.hosts.join(", "));
  writeFileSync(path.join(runDir, "notes.md"), notes);
}

export function copyEmailSendTemplate(runDir: string): void {
  mkdirSync(runDir, { recursive: true });
  cpSync(repoPath("templates", "email_send"), runDir, { recursive: true });
}
