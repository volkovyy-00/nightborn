// Builder (SPEC §9 "Code forge", T3, FORGE_MODE=code): a Pi session with exactly the charter's code_tools
// (web_search, http_get, write_skill, run_test, submit_skill). Writes only into staging/<runId>/; iterates
// against the Warden + sandboxed Test in-loop (≤ code_max_test_runs); limits enforced by the host.
// A failure before submit_skill → the caller falls back to the recipe forge once. No retry after submit.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { InputValues, Item, Job, Manifest } from "./types.ts";
import { getCharter } from "./charter.ts";
import { dataPath, REPO_ROOT } from "./paths.ts";
import { createPiSession, sessionStats } from "./pi.ts";
import { makeResearchTools, toolText, type StepLogger } from "./explorer.ts";
import { coerceInputs, slugifyName, uniqueName } from "./forge.ts";
import { PROTECTED, SECRET, wardenPre, wardenPrecheckDeny, wipeStaging } from "./warden.ts";
import { runSkill } from "./exec.ts";
import { brokerGrant, clearProvisionalGrant, getProvisionalGrant, setProvisionalGrant } from "./broker.ts";
import { manifestSchema, validateOutput } from "../templates/schemas.ts";

const FILES = new Set(["skill.mjs", "notes.md", "manifest.json"]);
const CONTENT_MAX = 64 * 1024;
const STDERR_MAX = 2 * 1024; // what the model sees of a failed run (SPEC §9)
const ITEMS_MAX = 5;

export type CodeForgeResult =
  | { ok: true; name: string; runDir: string; visited: string[]; lastPassingInputs: InputValues; tokens: number; costUsd: number; ms: number }
  | { ok: false; reason: string; tokens: number; costUsd: number; ms: number };

/** Runner-owned plumbing the Builder's in-loop Test needs (keeps builder.ts free of a runner import). */
export type BuilderDeps = {
  skillsRoot: string;
  stdinExtras: () => { baseUrl?: string };
  runHosts: (hosts: string[]) => string[];
};

export type BuildCodeFn = (job: Job, step: StepLogger, deps: BuilderDeps, request?: string) => Promise<CodeForgeResult>;

// ── system prompt ─────────────────────────────────────────────────────────

/** The string literals in a draft that trip the Warden's regexes — for the model's feedback only (never logged). */
function offendingLiterals(src: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    // a backtick template is scanned part by part: the text between ${…} placeholders counts as a literal
    const parts = m[3] !== undefined ? raw.split(/\$\{[^}]*\}/) : [raw];
    for (const p of parts) if (re.test(p)) out.push(JSON.stringify(p.slice(0, 60)));
  }
  return [...new Set(out)].slice(0, 5);
}

const SKELETON = `// skill.mjs — plain ESM, NO imports. Reads stdin, writes stdout, exits 0.
let raw = "";
for await (const c of process.stdin) raw += c;
const input = JSON.parse(raw || "{}");
const inputs = input.inputs ?? {};
const max = Number(input.max) > 0 ? Math.floor(Number(input.max)) : 5;
const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").trim().replace(/\\s+/g, "-");
const num = (v) => { const m = String(v).match(/\\d[\\d\\s\\u00a0.,]*/); return m ? Number(m[0].replace(/[\\s\\u00a0]/g, "").replace(/[.,](?=\\d{3}(\\D|$))/g, "").replace(",", ".")) : NaN; };
// URLs: ONE absolute https template string per URL with {placeholders}, filled by .replace(). Never a "/" string,
// never a backtick template with / between \${} parts, never a string starting with "/".
const SEARCH = "https://www.example.com/api/v1/items/search?limit=20&q={make}:{model}&price_to={max_price}";
const DETAIL = "https://www.example.com/detail/{make}/{model}/{id}";
const fill = (tpl, vals) => tpl.replace(/\\{([a-z_]+)\\}/g, (_, k) => encodeURIComponent(vals[k] ?? ""));
const u = new URL(fill(SEARCH, { make: slug(inputs.make), model: slug(inputs.model), max_price: String(inputs.max_price) }));
const target = input.baseUrl ? new URL(u.host + u.pathname + u.search, input.baseUrl) : u; // baseUrl = offline mock, keep this line
const res = await fetch(target, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
if (!res.ok) { process.stderr.write("http " + res.status + "\\n"); process.exit(1); }
const data = await res.json();
const items = (data.results ?? [])
  .filter((it) => !(num(it.price) > Number(inputs.max_price)))
  .map((it) => ({
    title: String(it.name ?? ""),
    url: fill(DETAIL, { make: it.manufacturer_cb?.seo_name, model: it.model_cb?.seo_name, id: it.id }),
    snippet: num(it.price) + " Kč",
  }));
process.stdout.write(JSON.stringify({ items: items.slice(0, max) }));`;

function systemPrompt(limits: { turns: number; seconds: number; tests: number }): string {
  return [
    "You are Nightborn's Builder. You write ONE reusable, parameterised hand (a tiny Node script) for the user's kind of request, test it, fix it, submit it. Nobody tells you which site to use: you find a public keyless JSON API by searching and fetching. The hand must serve future requests of the same kind with different values.",
    "",
    "Tools (one call per turn):",
    "- web_search({q, endpoint:\"news\"|\"web\"}): Brave search, ≤5 hits. Queries in ENGLISH; name the country the request implies (prices in Kč → Czechia). Does NOT count as visiting a host.",
    "- http_get({url}): fetch one public https URL. JSON → pretty-printed (≤16 KB). HTML → a DIGEST: \"data endpoints this page itself calls\" (the site's own JSON API URLs with params and response shape), link shapes for item pages, text. Every host you fetch successfully (2xx) becomes an allowed host for the hand; the hand may use ONLY such hosts.",
    "- write_skill({file, content}): write skill.mjs, manifest.json or notes.md (no other file name). Overwrite to fix.",
    "- run_test({inputs}): the Warden scans your code, then it runs sandboxed with these inputs. Returns the first items on success; THROWS the Warden's failure code or the run's stderr on failure. You get " + limits.tests + " test runs in total.",
    "- submit_skill(): final action; allowed only after a passing run_test with no edits since.",
    "",
    `Budget: ${limits.turns} turns and ${limits.seconds} seconds in total, no retry. Aim: search (1–2) → http_get the listing page (1) → http_get the endpoint filled with the user's values (1) → write manifest.json + skill.mjs (2) → run_test (1) → fix if needed → submit_skill.`,
    "",
    "Procedure: 1) web_search for the leading sites of this kind in that country; pick the primary national marketplace, not an aggregator. 2) web_search the user's item together with that domain and take a listing page URL from the results (never invent URLs). 3) http_get the listing page; in the digest pick the data endpoint whose response is the item list and the item-page link shape. 4) http_get that endpoint with the user's values to see the real response. 5) write manifest.json, then skill.mjs, then notes.md (2–4 lines: source, endpoint, inputs). 6) run_test with the user's values. 7) submit_skill.",
    "",
    "The hand contract (stdin → stdout):",
    "- stdin JSON: { inputs: {<input name>: string|number}, baseUrl?: string, max?: number }. User values arrive ONLY here. Never put the user's literal values in the code.",
    "- stdout JSON, exit 0: { items: [{ title: string, url: string, snippet?: string, date?: string }] } — ≥1 item with a non-empty url, at most `max` (default 5). On any failure write a short message to stderr and exit 1.",
    "- When input.baseUrl is set, request new URL(u.host + u.pathname + u.search, input.baseUrl) instead of u (offline mock); keep that line as in the skeleton.",
    "",
    "WARDEN RULES — the code is statically scanned and REJECTED on any of these (fix = rewrite, a rejection costs a test run):",
    "- No import/require of anything; no fs, no child processes, no eval/Function/dynamic import(), no Reflect, Symbol.for, WebSocket, getBuiltinModule, createRequire, no process[...] / globalThis[...] computed access.",
    "- Only the global fetch, always with signal: AbortSignal.timeout(6000) and header Accept: application/json. Follow no redirects (they throw).",
    "- No process.env at all (keyless APIs only). Never a key-like string.",
    "- NO string literal that starts with \"/\" — not even \"/\" as a path separator, and no backtick template with a / between ${} parts (each part between placeholders is scanned as its own string). Build every URL from ONE absolute https template string with {placeholders} filled by .replace(), exactly as in the skeleton. No string containing \"../\", \".env\", \"broker\" or \"charter.md\".",
    "- Every URL literal is absolute https:// and its host is one you fetched with http_get in this session, and is listed in manifest.hosts.",
    "- manifest.capabilities is exactly [\"net:fetch\"] — nothing else.",
    "",
    "manifest.json: { name: snake_case generic name for the kind of task (e.g. find_used_cars), never the user's value; purpose: one sentence a router can match future requests against; inputs: 1–6 of { name (snake_case, ≤24), type \"string\"|\"number\", format \"text\"|\"slug\" (slug = lowercased, diacritics stripped, spaces → \"-\"), required, description }; capabilities: [\"net:fetch\"]; hosts: exactly the hosts of the URL literals in skill.mjs }. Name inputs like the user's value keys when they fit; prices are numbers. The host may rename the hand; the tool result tells you the final name.",
    "",
    "Skeleton that passes the Warden (replace example.com with the host you fetched; keep its structure):",
    SKELETON,
  ].join("\n");
}

// ── session ───────────────────────────────────────────────────────────────

/** Strip absolute paths before anything reaches the model (it may echo them into notes.md → protected_path). */
function scrubPaths(s: string, runDir: string): string {
  return s.split(runDir).join("<hand>").split(dataPath("staging")).join("<staging>").split(REPO_ROOT).join("<repo>");
}

export const buildCode: BuildCodeFn = async (job, step, deps, request) => {
  const t0 = Date.now();
  const limits = getCharter().forge;
  const runId = randomUUID().slice(0, 8);
  const runDir = dataPath("staging", runId);
  const zero = (reason: string): CodeForgeResult => ({ ok: false, reason, tokens: 0, costUsd: 0, ms: Date.now() - t0 });
  try {
    mkdirSync(runDir, { recursive: true });
  } catch {
    return zero("builder: staging failed");
  }

  const visited: string[] = [];
  let name: string | null = null;
  let manifest: Manifest | null = null;
  let tests = 0;
  let dirty = true; // edits since the last passing test
  let lastPassingInputs: InputValues | null = null;
  let submitted = false;
  const after = () => (submitted ? toolText("skill already submitted", true) : null);
  const [webSearch, httpGet] = makeResearchTools({ visited, step, after });

  const writeSkill = defineTool({
    name: "write_skill",
    label: "Write skill file",
    description: "Write skill.mjs, manifest.json or notes.md into the hand's folder (overwrites).",
    parameters: Type.Object({ file: Type.String(), content: Type.String() }),
    executionMode: "sequential",
    async execute(_id, p) {
      const done = after();
      if (done) return done;
      // The tool_call hook blocks other names before we get here; this is the second layer.
      if (!FILES.has(p.file)) throw new Error("only skill.mjs, notes.md, manifest.json");
      if (p.content.length > CONTENT_MAX) throw new Error("content too long (max 64 KB)");
      let content = p.content;
      if (p.file === "manifest.json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(p.content);
        } catch {
          throw new Error("manifest.json is not valid JSON");
        }
        const r = manifestSchema.safeParse(parsed);
        if (!r.success) throw new Error(`manifest.json: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 300)}`);
        if (name === null) name = uniqueName(slugifyName(job.skill && job.skill.trim() ? job.skill : r.data.name), deps.skillsRoot);
        manifest = { ...r.data, name, kind: "code", purpose: r.data.purpose.slice(0, 200) };
        content = `${JSON.stringify(manifest, null, 2)}\n`;
      }
      writeFileSync(path.join(runDir, p.file), content, "utf8");
      dirty = true;
      step(`write: ${p.file}`);
      return toolText(p.file === "manifest.json" ? `written; the hand's name is ${name}` : "written");
    },
  });

  const runTest = defineTool({
    name: "run_test",
    label: "Run test",
    description: "Warden scan + sandboxed run with these inputs. Throws the failure code or stderr on failure.",
    parameters: Type.Object({ inputs: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])) }),
    executionMode: "sequential",
    async execute(_id, p, signal) {
      const done = after();
      if (done) return done;
      if (tests >= limits.codeMaxTestRuns) throw new Error("test budget exhausted: submit_skill if a run passed, otherwise stop");
      if (!manifest || !name) throw new Error("write manifest.json first");
      const missing = [...FILES].filter((f) => !existsSync(path.join(runDir, f)));
      if (missing.length) throw new Error(`write ${missing.join(", ")} first (all three files are hashed together)`);
      tests++;
      const k = `${tests}/${limits.codeMaxTestRuns}`;
      let pre: ReturnType<typeof wardenPre>;
      try {
        pre = wardenPre(runDir, { job, name, visited });
      } catch {
        step(`test ${k}: forge_invalid`);
        throw new Error("warden: could not read the hand's files (manifest.json must be valid JSON)");
      }
      if (!pre.ok) {
        wardenPrecheckDeny(name, pre.failureCode, pre.caps, pre.detail);
        step(`test ${k}: ${pre.failureCode}`);
        // The log stays clean (SPEC §12); the model gets the offending literals so it can fix them.
        let hint = "";
        if (pre.failureCode === "protected_path" || pre.failureCode === "secret_in_file") {
          let src = "";
          try {
            src = readFileSync(path.join(runDir, "skill.mjs"), "utf8");
          } catch {
            src = "";
          }
          const lits = offendingLiterals(src, pre.failureCode === "protected_path" ? PROTECTED : SECRET);
          if (lits.length) hint = ` — offending string literals: ${lits.join(", ")}. A string may not start with "/" (use one absolute https template with {placeholders} + .replace(), no "/" separators, no backtick URLs)`;
        } else if (pre.failureCode === "host_not_allowed") {
          hint = ` — every URL host in skill.mjs must be in manifest.hosts and fetched with http_get (visited: ${visited.join(", ") || "none"})`;
        } else if (pre.failureCode === "manifest_mismatch") {
          hint = " — manifest.capabilities must be exactly [\"net:fetch\"] and the code may use nothing but fetch (no fs, no env)";
        }
        throw new Error(`warden: ${pre.failureCode} — ${pre.detail}${hint}`);
      }
      const inputs = coerceInputs(manifest.inputs, p.inputs);
      if (!inputs) {
        step(`test ${k}: inputs`);
        throw new Error("inputs do not fit manifest.inputs (required missing or a number input is not numeric)");
      }
      setProvisionalGrant(runId, pre.env);
      try {
        const r = await runSkill(
          path.join(runDir, "skill.mjs"),
          runDir,
          { inputs, max: ITEMS_MAX, ...deps.stdinExtras() },
          brokerGrant(getProvisionalGrant(runId)),
          deps.runHosts(manifest.hosts),
          { signal },
        );
        if (r.timedOut || r.overflow || !r.ok) {
          const code = r.timedOut ? "timeout" : "test_exit_nonzero";
          step(`test ${k}: ${code}`, r.ms);
          throw new Error(`${code}: ${scrubPaths(r.stderr, runDir).slice(0, STDERR_MAX) || `exit ${r.code ?? "signal"}`}`);
        }
        const v = validateOutput(r.stdout);
        if (!v.ok) {
          step(`test ${k}: schema_invalid`, r.ms);
          throw new Error(`schema_invalid: ${v.reason} (stdout must be {"items":[{title,url,...}]} with ≥1 non-empty url)`);
        }
        lastPassingInputs = inputs;
        dirty = false;
        step(`test ${k}: pass · ${v.items.length} items`, r.ms);
        const sample = v.items.slice(0, 3).map((i: Item) => ({ title: i.title, url: i.url }));
        return toolText(`pass: ${v.items.length} items. First: ${JSON.stringify(sample)}`);
      } finally {
        clearProvisionalGrant(runId);
      }
    },
  });

  const submit = defineTool({
    name: "submit_skill",
    label: "Submit skill",
    description: "Final action: hand the tested skill to the Warden for install. Only after a passing run_test with no edits since.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute() {
      const done = after();
      if (done) return done;
      if (!lastPassingInputs) throw new Error("run a passing run_test first");
      if (dirty) throw new Error("files changed since the last passing test: run_test again");
      submitted = true;
      step("submit_skill");
      return toolText("submitted", true);
    },
  });

  let session: Awaited<ReturnType<typeof createPiSession>>;
  try {
    session = await createPiSession({
      role: "forge",
      systemPrompt: systemPrompt({ turns: limits.codeMaxTurns, seconds: limits.codeMaxSeconds, tests: limits.codeMaxTestRuns }),
      customTools: [webSearch, httpGet, writeSkill, runTest, submit],
      // SPEC §9: write_skill to any other file name is blocked by the tool_call hook.
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", (ev) => {
            if (ev.toolName === "write_skill" && !FILES.has(String((ev.input as { file?: unknown }).file))) {
              return { block: true, reason: "only skill.mjs, notes.md, manifest.json may be written" };
            }
            return undefined;
          });
        },
      ],
    });
  } catch {
    wipeStaging(runDir);
    return zero("builder: session failed");
  }

  let limitHit = false;
  let turns = 0;
  const timer = setTimeout(() => {
    if (submitted) return;
    limitHit = true;
    void session.abort();
  }, limits.codeMaxSeconds * 1000);
  const unsub = session.subscribe((ev) => {
    if (ev.type === "turn_end" && ++turns >= limits.codeMaxTurns && !submitted) {
      limitHit = true;
      void session.abort();
    }
  });
  let internal = false;
  try {
    await session.prompt(
      `${request ? `User request: ${JSON.stringify(request.slice(0, 300))}\n` : ""}Intent: ${JSON.stringify(job.intent)}\nUser values: ${JSON.stringify(job.inputs)}\n\nFind a source (English search queries), read it, write the hand, run_test with the user's values, then submit_skill.`,
    );
  } catch {
    internal = !limitHit; // a preflight rejection; a limit abort resolves normally
  } finally {
    clearTimeout(timer);
    unsub();
  }
  const { tokens, costUsd } = sessionStats(session);
  session.dispose();
  const ms = Date.now() - t0;
  if (!submitted || !name || !lastPassingInputs) {
    wipeStaging(runDir);
    const reason = limitHit ? "builder: limit" : internal ? "builder: session error" : "builder: no submit_skill";
    return { ok: false, reason, tokens, costUsd, ms };
  }
  // Sanity: the staged manifest is what the Warden will read.
  try {
    JSON.parse(readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  } catch {
    wipeStaging(runDir);
    return { ok: false, reason: "builder: manifest unreadable", tokens, costUsd, ms };
  }
  return { ok: true, name, runDir, visited, lastPassingInputs, tokens, costUsd, ms };
};
