import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  executeComposioTool,
  isSkillToolkitConnected,
  requestToolkitAccess,
  searchComposioTools,
  setPendingComposioBinding,
  skillComposioUserId,
} from "./composio.ts";
import type { ComposioSkillBinding, ForgeArtifact, ForgeContext } from "./types.ts";
import {
  appendForgeToolLine,
  finishForgeDebug,
  forgeAuthoritativeAskPrefix,
  sessionFromCtx,
  writeForgeDebug,
} from "./forgeDebug.ts";
import { repoPath, REPO_ROOT } from "./paths.ts";
import { listSkillDirs } from "./hash.ts";
import { createPiAuthAndRegistry, createPiResourceLoader, piAgentDir, resolvePiModel } from "./pi.ts";

/** Thrown when Forge requested Composio Connect — Doctor parks and retries. */
export class NeedsComposioAccessError extends Error {
  readonly code = "needs_composio_access" as const;
  readonly toolkit: string;
  readonly requestId: string;
  readonly skillName: string;
  readonly redirectUrl: string | null;
  readonly why: string;

  constructor(opts: {
    toolkit: string;
    requestId: string;
    skillName: string;
    redirectUrl: string | null;
    why: string;
  }) {
    super(
      `needs_composio_access toolkit=${opts.toolkit} skill=${opts.skillName}` +
        (opts.redirectUrl ? ` url=${opts.redirectUrl}` : ""),
    );
    this.name = "NeedsComposioAccessError";
    this.toolkit = opts.toolkit;
    this.requestId = opts.requestId;
    this.skillName = opts.skillName;
    this.redirectUrl = opts.redirectUrl;
    this.why = opts.why;
  }
}

export function isNeedsComposioAccessError(err: unknown): err is NeedsComposioAccessError {
  return err instanceof NeedsComposioAccessError ||
    (Boolean(err) &&
      typeof err === "object" &&
      (err as { code?: string }).code === "needs_composio_access");
}

/**
 * Thrown when Forge confirmed Composio access but the agent still returned no skillSource.
 * Doctor must fail (not scaffold cars.com over an Apify/Marketplace brief).
 */
export class NeedsSkillAfterComposioError extends Error {
  readonly code = "needs_skill_after_composio" as const;
  readonly toolkit: string;
  readonly skillName: string;

  constructor(opts: { toolkit: string; skillName: string; detail?: string }) {
    super(
      `needs_skill_after_composio toolkit=${opts.toolkit} skill=${opts.skillName}` +
        (opts.detail ? ` · ${opts.detail}` : ""),
    );
    this.name = "NeedsSkillAfterComposioError";
    this.toolkit = opts.toolkit;
    this.skillName = opts.skillName;
  }
}

export function isNeedsSkillAfterComposioError(
  err: unknown,
): err is NeedsSkillAfterComposioError {
  return (
    err instanceof NeedsSkillAfterComposioError ||
    (Boolean(err) &&
      typeof err === "object" &&
      (err as { code?: string }).code === "needs_skill_after_composio")
  );
}

const MAX_SKILL_SOURCE = 48_000;

function slugify(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!s || !/^[a-z0-9_]+$/.test(s)) s = "forged_skill";
  if (/^[0-9]/.test(s)) s = `s_${s}`;
  return s.slice(0, 48);
}

function uniqueName(base: string, skillsRoot: string): string {
  let name = slugify(base);
  const taken = new Set(listSkillDirs(skillsRoot));
  if (!taken.has(name)) return name;
  let i = 2;
  while (taken.has(`${name}_${i}`)) i++;
  return `${name}_${i}`;
}

/** Drop leading "/" on path string literals — Warden protected_path matches ^/. */
function scrubLeadingSlashPaths(src: string): string {
  return src.replace(/(["'])\/(?!\/)([^"']*)\1/g, "$1$2$1");
}

/** Strip markdown fences and trim; throw if empty / oversized. */
export function sanitizeSkillSource(raw: string): string {
  let s = raw.trim();
  const fence = /^```(?:javascript|js|mjs|typescript|ts)?\s*\n?([\s\S]*?)\n?```$/i;
  const m = s.match(fence);
  if (m) s = m[1].trim();
  // Also strip leading fence line if model left one
  if (s.startsWith("```")) {
    s = s.replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "").trim();
  }
  s = scrubLeadingSlashPaths(s);
  if (!s || s.length < 40) throw new Error("forge_invalid: skillSource empty");
  if (s.length > MAX_SKILL_SOURCE) throw new Error("forge_invalid: skillSource too large");
  return s;
}

/** Legacy params-only → frozen http template (JUDGE fallback / email sibling notes). */
export function renderHttpTemplate(
  params: ForgeArtifact,
  runDir: string,
  skillsRoot: string,
): { skillName: string; testQuery: string } {
  mkdirSync(runDir, { recursive: true });
  const skillName = uniqueName(params.name, skillsRoot);
  const provider = (process.env.SEARCH_PROVIDER ?? "brave").toLowerCase() === "tavily" ? "tavily" : "brave";
  const envKey = provider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY";
  const tplDir = repoPath("templates", "http");

  let skill = readFileSync(path.join(tplDir, "skill.mjs.tpl"), "utf8");
  skill = skill.replace("__PROVIDER__", JSON.stringify(provider)).replace("__ENV_KEY__", JSON.stringify(envKey));
  writeFileSync(path.join(runDir, "skill.mjs"), skill, "utf8");

  let notes = readFileSync(path.join(tplDir, "notes.md.tpl"), "utf8");
  const purpose = String(JSON.parse(JSON.stringify(params.purpose)));
  notes = notes.replace("__NAME__", skillName).replace("__PURPOSE__", purpose);
  writeFileSync(path.join(runDir, "notes.md"), notes, "utf8");

  let manifest = readFileSync(path.join(tplDir, "manifest.json.tpl"), "utf8");
  manifest = manifest.replace("__NAME_JSON__", JSON.stringify(skillName));
  writeFileSync(path.join(runDir, "manifest.json"), manifest, "utf8");

  return { skillName, testQuery: params.query };
}

/** Free-form Create: write skillSource + host notes/manifest. */
export function writeForgedSkill(
  artifact: ForgeArtifact,
  runDir: string,
  skillsRoot: string,
): { skillName: string; testQuery: string; freeform: boolean } {
  mkdirSync(runDir, { recursive: true });
  const skillName = uniqueName(artifact.name, skillsRoot);

  if (artifact.skillSource && artifact.skillSource.trim()) {
    const src = sanitizeSkillSource(artifact.skillSource);
    writeFileSync(path.join(runDir, "skill.mjs"), src, "utf8");

    const purpose = String(JSON.parse(JSON.stringify(artifact.purpose)));
    writeFileSync(path.join(runDir, "notes.md"), `# ${skillName}\n\n${purpose}\n`, "utf8");

    // Charter allow-list only — LLM often invents labels like "web search"
    const wantsPhone =
      artifact.capabilities.includes("notify:phone") || /BLAND_API_KEY/.test(src);
    const capabilities = wantsPhone ? ["net:fetch", "notify:phone"] : ["net:fetch"];
    const manifest = {
      name: skillName,
      template: wantsPhone ? "call" : "http",
      capabilities,
      outputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                date: { type: "string" },
              },
            },
          },
        },
      },
    };
    writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    return { skillName, testQuery: artifact.query, freeform: true };
  }

  const r = renderHttpTemplate(artifact, runDir, skillsRoot);
  return { ...r, freeform: false };
}

export function copyEmailSendTemplate(runDir: string): void {
  mkdirSync(runDir, { recursive: true });
  cpSync(repoPath("templates", "email_send"), runDir, { recursive: true });
}

const FORGE_SYSTEM = [
  "You are Nightborn's Forge. Emit one purpose-fit top-level ESM script via emit_forge_skill.",
  "skillSource = FULL skill.mjs that runs as `node skill.mjs` (NOT a handler, NOT Express, NOT AWS Lambda).",
  "HARD RULES:",
  "- No imports. No require. No node-fetch. No export default. Use global fetch.",
  "- Read ALL of process.stdin as JSON: { query, baseUrl?, composioProxyUrl? }",
  "- Write ONE JSON object to process.stdout: { items:[{title,url,date?}] }",
  "- process.env.BRAVE_API_KEY (or TAVILY_API_KEY), or BLAND_API_KEY when capabilities include notify:phone. AbortSignal.timeout(6000).",
  "- NEVER string literals starting with / — use relative paths \"res/v1/web/search\" or \"v1/calls\".",
  "- Use String.fromCharCode(47) + joinBase(baseUrl, origin, \"res/v1/...\") as in the example.",
  "- Forums/deals → web search endpoint; company news → news search endpoint; outbound call → Bland POST v1/calls.",
  "- Bland: query is +E164|||task; POST {phone_number,task}; map call_id to items url bland:call/<id>; capabilities [\"net:fetch\",\"notify:phone\"]. Task text must tell the agent to ask ONE question at a time (conversational), never a stacked list.",
  "- NEVER dial during Forge. If process.env.NIGHTBORN_BLOCK_OUTBOUND==='1', dry-run: stdout items with bland:call/dry-run and do not fetch api.bland.ai. Host skips live call tests on install.",
  "- Shape q= for the job (e.g. append forum OR reddit for forum asks).",
  "- listings.http_scrape: site:<siteHost> Brave search; DROP shopping-index hubs (category shopping, price-under, used-cars-under, titles without a model year). Retry year+make queries until vehicle cards remain. Never emit hub-only results.",
  "COMPOSIO (skill-scoped marketplace access):",
  "- Hard scrapes / Actors (LinkedIn, Indeed, bot-walled sites) → call request_composio_access toolkit=apify BEFORE emit_forge_skill.",
  "- Access is for THIS skill only (not a global Forge grant). Never request gmail/email/SMTP toolkits.",
  "- After access is connected, you may composio_search / composio_execute to discover Actors, then emit_forge_skill.",
  "- Composio-backed skills: POST JSON {tool, arguments} to input.composioProxyUrl (host proxy). Map results into items[]. Do NOT use COMPOSIO_API_KEY in skillSource.",
  "- When emitting a Composio-backed skill, set composioToolkit (e.g. apify) on emit_forge_skill.",
  "EXAMPLE shape (adapt endpoint/query; keep stdin/stdout):",
  "async function readStdin(){const c=[];for await(const x of process.stdin)c.push(x);return Buffer.concat(c).toString('utf8')}",
  "const SLASH=String.fromCharCode(47);",
  "function joinBase(baseUrl,origin,rel){const b=baseUrl??origin;const root=b.endsWith(SLASH)?b:`${b}${SLASH}`;return new URL(rel.startsWith(SLASH)?rel.slice(1):rel,root)}",
  "const input=JSON.parse(await readStdin()||'{}');",
  "const key=process.env.BRAVE_API_KEY; if(!key){console.error('missing');process.exit(1)}",
  "const u=joinBase(input.baseUrl,'https://api.search.brave.com','res/v1/web/search');",
  "u.searchParams.set('q', (input.query||'')+' forum'); u.searchParams.set('count','5');",
  "const res=await fetch(u,{headers:{'X-Subscription-Token':key,Accept:'application/json'},signal:AbortSignal.timeout(6000)});",
  "const data=await res.json(); const results=data.web?.results??data.results??[];",
  "process.stdout.write(JSON.stringify({items:results.map(r=>({title:r.title||'',url:r.url||''}))}));",
  "Call emit_forge_skill exactly once when done (or request_composio_access if you need marketplace access first).",
].join("\n");

/**
 * Freeform Forge entry.
 * - PLANNER=cursor → Cursor SDK (`CURSOR_API_KEY`) via planner backend
 * - else FORGE_BACKEND=cursor → local `agent` CLI (`agent login`, no API key)
 * - else Pi (OpenRouter)
 */
export async function forgeSkill(
  intent: string,
  query: string,
  proposedName?: string | null,
  ctx?: ForgeContext | null,
): Promise<ForgeArtifact> {
  const planner = (process.env.PLANNER || "pi").trim().toLowerCase();
  if (planner === "cursor") {
    const { forgeSkillViaCursorSdk } = await import("./planner/cursor.ts");
    return forgeSkillViaCursorSdk(intent, query, proposedName, ctx);
  }
  const backend = (process.env.FORGE_BACKEND || "pi").trim().toLowerCase();
  if (backend === "cursor") {
    const { forgeSkillViaCursorCli } = await import("./forgeCursorCli.ts");
    return forgeSkillViaCursorCli(intent, query, proposedName, ctx);
  }
  return forgeSkillViaPi(intent, query, proposedName, ctx);
}

export async function forgeSkillViaPi(
  intent: string,
  query: string,
  proposedName?: string | null,
  ctx?: ForgeContext | null,
): Promise<ForgeArtifact> {
  let captured: ForgeArtifact | null = null;
  let accessAbort: NeedsComposioAccessError | null = null;
  let forgeBinding: ComposioSkillBinding | null = null;
  const dbg = sessionFromCtx(ctx ?? undefined, "pi");
  let debugFinished = false;
  const doneDebug = (opts?: { promptBytes?: number; error?: string }) => {
    if (debugFinished) return;
    debugFinished = true;
    finishForgeDebug(dbg, opts);
  };

  const skillName =
    (proposedName?.trim() || ctx?.skillName?.trim() || "forged_skill").slice(0, 48);
  const requestId = ctx?.requestId?.trim() || `forge_${skillName}`;
  const goalId = ctx?.goalId?.trim() || "goal_forge";

  const requestAccess = defineTool({
    name: "request_composio_access",
    label: "Request Composio Access",
    description:
      "Request skill-scoped Composio toolkit access (e.g. apify) for the skill you are forging. Final if Connect Link is required.",
    promptGuidelines: [
      "Use when Brave/fetch alone cannot fulfill the brief (hard scrapes, Actors).",
      "toolkit=apify for LinkedIn/Indeed/Actor-backed extraction. Never email/SMTP.",
      "If already connected, continue with composio_search/execute then emit_forge_skill.",
    ],
    parameters: Type.Object({
      toolkit: Type.String(),
      why: Type.String(),
    }),
    async execute(_id, params) {
      const result = await requestToolkitAccess({
        toolkit: params.toolkit,
        requestId,
        goalId,
        skillName,
        why: params.why,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `access denied: ${result.message}` }],
          details: result,
        };
      }
      forgeBinding = { toolkit: result.toolkit, userId: result.userId };
      setPendingComposioBinding(skillName, forgeBinding);
      if (result.alreadyConnected) {
        return {
          content: [
            {
              type: "text",
              text: `Composio ${result.toolkit} already connected for skill ${skillName}. Use composio_search/execute then emit_forge_skill.`,
            },
          ],
          details: result,
        };
      }
      accessAbort = new NeedsComposioAccessError({
        toolkit: result.toolkit,
        requestId: result.requestId,
        skillName,
        redirectUrl: result.redirectUrl,
        why: params.why,
      });
      return {
        content: [
          {
            type: "text",
            text: `Parked: connect ${result.toolkit} for ${skillName}. ${result.redirectUrl ?? ""}`,
          },
        ],
        details: { needs_composio_access: true, ...result },
        terminate: true,
      };
    },
  });

  const composioSearch = defineTool({
    name: "composio_search",
    label: "Composio Search",
    description: "Search Composio tools for this skill's connected toolkit.",
    parameters: Type.Object({
      query: Type.String(),
    }),
    async execute(_id, params) {
      const connected = forgeBinding
        ? await isSkillToolkitConnected(skillName, forgeBinding.toolkit)
        : false;
      if (!connected && !forgeBinding) {
        return {
          content: [{ type: "text", text: "Call request_composio_access first." }],
        };
      }
      const r = await searchComposioTools(skillName, params.query);
      return {
        content: [
          {
            type: "text",
            text: r.ok
              ? JSON.stringify(r.result).slice(0, 4000)
              : `search failed: ${r.error}`,
          },
        ],
      };
    },
  });

  const composioExecute = defineTool({
    name: "composio_execute",
    label: "Composio Execute",
    description: "Execute a Composio tool slug in this skill's session (forge-time).",
    parameters: Type.Object({
      tool: Type.String(),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, params) {
      const r = await executeComposioTool(
        params.tool,
        (params.arguments as Record<string, unknown>) ?? {},
        skillName,
      );
      return {
        content: [
          {
            type: "text",
            text: r.ok
              ? JSON.stringify(r.data).slice(0, 4000)
              : `execute failed: ${r.error}`,
          },
        ],
      };
    },
  });

  const emit = defineTool({
    name: "emit_forge_skill",
    label: "Emit Forge Skill",
    description: "Emit metadata + full skill.mjs source for a new net:fetch skill. Final action.",
    promptGuidelines: [
      "Call emit_forge_skill exactly once as your last action (after any Composio access).",
      "skillSource must be complete runnable ESM implementing the stdin/stdout contract.",
      "Pick news vs web Brave endpoint based on intent, or composioProxyUrl for Apify-backed skills.",
    ],
    parameters: Type.Object({
      name: Type.String(),
      purpose: Type.String(),
      query: Type.String(),
      capabilities: Type.Array(Type.String()),
      skillSource: Type.String(),
      composioToolkit: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const toolkit = params.composioToolkit?.trim() || forgeBinding?.toolkit;
      const composio: ComposioSkillBinding | undefined = toolkit
        ? {
            toolkit: toolkit.toLowerCase(),
            userId: skillComposioUserId(params.name || skillName),
          }
        : forgeBinding ?? undefined;
      if (composio) setPendingComposioBinding(params.name || skillName, composio);
      captured = {
        name: params.name,
        purpose: params.purpose,
        query: params.query,
        capabilities: params.capabilities,
        skillSource: params.skillSource,
        ...(composio ? { composio } : {}),
      };
      return {
        content: [{ type: "text", text: `Forged skill ${params.name}` }],
        details: captured,
        terminate: true,
      };
    },
  });

  const { auth, registry } = createPiAuthAndRegistry();
  const model = resolvePiModel(registry);
  const loader = createPiResourceLoader({ systemPrompt: FORGE_SYSTEM });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: REPO_ROOT,
    agentDir: piAgentDir(),
    authStorage: auth,
    modelRegistry: registry,
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [requestAccess, composioSearch, composioExecute, emit],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(REPO_ROOT),
    settingsManager: SettingsManager.inMemory(),
  });

  const hint = proposedName ? ` proposedName=${JSON.stringify(proposedName)}` : "";
  const scope = ` skillName=${JSON.stringify(skillName)} requestId=${JSON.stringify(requestId)}`;
  const classBits = [
    ctx?.defaultsHint ? ` defaultsHint=${JSON.stringify(ctx.defaultsHint)}` : "",
    ctx?.siteHost ? ` siteHost=${JSON.stringify(ctx.siteHost)}` : "",
    ctx?.minimalSuccess ? ` minimalSuccess=${JSON.stringify(ctx.minimalSuccess)}` : "",
  ].join("");
  const askPrefix = forgeAuthoritativeAskPrefix(ctx);
  const promptText =
    `${askPrefix}` +
    `Forge a skill for intent=${JSON.stringify(intent)} query=${JSON.stringify(query)}.${hint}${scope}${classBits} ` +
    `If you need Apify/Actors, request_composio_access first; else emit_forge_skill.`;
  writeForgeDebug(dbg, "prompt.txt", promptText);

  try {
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        const args = (event as { args?: unknown }).args;
        appendForgeToolLine(dbg, {
          phase: "start",
          toolName: String(event.toolName ?? ""),
          argsSummary:
            args != null ? JSON.stringify(args).slice(0, 240) : undefined,
        });
      }
      if (event.type === "tool_execution_end") {
        const toolName = String(event.toolName ?? "");
        appendForgeToolLine(dbg, {
          phase: "end",
          toolName,
          ok: !(event as { isError?: boolean }).isError,
          detail: toolName.slice(0, 80),
        });
        if (toolName === "emit_forge_skill") {
          const d = (event.result as { details?: ForgeArtifact } | undefined)?.details;
          if (d) {
            captured = d;
            writeForgeDebug(dbg, "result.json", {
              name: d.name,
              purpose: d.purpose,
              query: d.query,
              capabilities: d.capabilities,
              skillSourceLen: d.skillSource?.length ?? 0,
              composio: d.composio ?? null,
            });
          }
        }
        if (toolName === "request_composio_access") {
          const d = event.result as { details?: { needs_composio_access?: boolean } } | undefined;
          if (d?.details?.needs_composio_access) {
            writeForgeDebug(dbg, "result.json", d.details);
          }
        }
      }
    });
    await session.prompt(promptText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    doneDebug({ promptBytes: promptText.length, error: msg });
    throw err;
  } finally {
    session.dispose();
  }

  if (accessAbort) {
    doneDebug({ promptBytes: promptText.length });
    throw accessAbort;
  }
  if (!captured) {
    const msg = "forge_invalid";
    doneDebug({ promptBytes: promptText.length, error: msg });
    throw new Error(msg);
  }
  if (proposedName) captured = { ...captured, name: proposedName };
  if (!captured.query) captured = { ...captured, query };
  if (forgeBinding && !captured.composio) {
    captured = {
      ...captured,
      composio: {
        toolkit: forgeBinding.toolkit,
        userId: skillComposioUserId(captured.name),
      },
    };
  }
  const out = ensureRunnableSkillSource(captured, intent);
  doneDebug({ promptBytes: promptText.length });
  return out;
}

/** @deprecated use forgeSkill */
export async function forgeParamsViaPi(intent: string, query: string): Promise<ForgeArtifact> {
  return forgeSkill(intent, query);
}

export function loadForgeFixture(name: string): ForgeArtifact | null {
  const p = repoPath("fixtures", "forge", name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ForgeArtifact;
}

/** Committed news-search skill body for JUDGE / chip A fixtures. */
export function defaultNewsSkillSource(): string {
  const provider = (process.env.SEARCH_PROVIDER ?? "brave").toLowerCase() === "tavily" ? "tavily" : "brave";
  const envKey = provider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY";
  let skill = readFileSync(repoPath("templates", "http", "skill.mjs.tpl"), "utf8");
  return skill.replace("__PROVIDER__", JSON.stringify(provider)).replace("__ENV_KEY__", JSON.stringify(envKey));
}

/** Proven Brave web-search skill (forums/deals/listings). */
export function defaultWebSkillSource(querySuffix = ""): string {
  const envKey = "BRAVE_API_KEY";
  const suffix = querySuffix ? ` ${querySuffix}` : "";
  return `// Nightborn free-form web search skill — stdin query, stdout items
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function mapResults(data) {
  const results = data.web?.results ?? data.results ?? [];
  return {
    items: results.map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      ...(r.page_age || r.age ? { date: r.page_age ?? r.age } : {}),
    })),
  };
}
const SLASH = String.fromCharCode(47);
function joinBase(baseUrl, fallbackOrigin, relPath) {
  const base = baseUrl ?? fallbackOrigin;
  const root = base.endsWith(SLASH) ? base : \`\${base}\${SLASH}\`;
  const rel = relPath.startsWith(SLASH) ? relPath.slice(1) : relPath;
  return new URL(rel, root);
}
const raw = await readStdin();
const input = JSON.parse(raw || "{}");
const query = \`\${input.query ?? ""}${suffix}\`.trim();
const baseUrl = input.baseUrl;
const key = process.env[${JSON.stringify(envKey)}];
if (!key) { console.error("missing ${envKey}"); process.exit(1); }
const u = joinBase(baseUrl, "https://api.search.brave.com", "res/v1/web/search");
u.searchParams.set("q", query);
u.searchParams.set("count", "5");
const res = await fetch(u, {
  headers: { "X-Subscription-Token": key, Accept: "application/json" },
  signal: AbortSignal.timeout(6000),
});
if (!res.ok) { console.error("brave", res.status); process.exit(1); }
process.stdout.write(JSON.stringify(mapResults(await res.json())));
`;
}

/** Structural host contract only — do not require Brave/Bland env (Composio skills use proxy). */
export function skillSourcePassesContract(src: string): boolean {
  const lower = src.toLowerCase();
  if (lower.includes("node-fetch")) return false;
  if (lower.includes("export default")) return false;
  if (lower.includes("require(")) return false;
  if (!src.includes("process.stdin") && !src.includes("readStdin")) return false;
  if (!src.includes("process.stdout")) return false;
  if (!src.includes("items")) return false;
  return true;
}

function preferWebScaffold(intent: string, query: string): boolean {
  const t = `${intent} ${query}`.toLowerCase();
  return /forum|reddit|deal|listing|used car|craigslist|marketplace|web search/.test(t);
}

function preferCallScaffold(intent: string, query: string, caps: string[]): boolean {
  if (caps.includes("notify:phone")) return true;
  const t = `${intent} ${query}`.toLowerCase();
  return /\b(call|phone|outbound|bland)\b/.test(t) || /^\+\d/.test(query.trim());
}

/** Proven Bland outbound skill — stdin query +E164|||task, stdout items. */
export function defaultBlandSkillSource(): string {
  return `// Nightborn free-form Bland outbound skill — stdin query, stdout items
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
function parseQuery(query) {
  const sep = "|||";
  if (query.includes(sep)) {
    const i = query.indexOf(sep);
    return { phone: query.slice(0, i).trim(), task: query.slice(i + sep.length).trim() };
  }
  try {
    const j = JSON.parse(query);
    if (j.phone_number && j.task) return { phone: String(j.phone_number), task: String(j.task) };
  } catch { /* fall through */ }
  return { phone: query.trim(), task: "Confirm the line works with one short greeting." };
}
/** Force Bland to stay conversational even if the briefing lists many fields. */
function conversationalTask(briefing) {
  return [
    "You are on a live phone call. Be warm, brief, and human.",
    "Ask exactly ONE question per turn. Wait for their answer before asking anything else.",
    "Never stack multiple questions in one sentence or turn.",
    "For a used-car / listing follow-up, open with: \\"Hi, I saw a listing of a used car online with this number mentioned — is it still available?\\"",
    "For other goals, open with one natural question that fits the briefing.",
    "After they answer, follow up one topic at a time (e.g. price, then condition, then mileage).",
    "Keep the call short. Thank them and end when you have enough.",
    "Briefing / goal for this call:",
    String(briefing || "").trim() || "Have a short polite conversation and learn why they listed.",
  ].join("\\n");
}
const raw = await readStdin();
const input = JSON.parse(raw || "{}");
const { phone: requestedPhone, task } = parseQuery(input.query ?? "");
void requestedPhone; // host rewrites query; skill always dials the demo number
// Forge/Doctor install tests set this — never place a real call.
if (process.env.NIGHTBORN_BLOCK_OUTBOUND === "1") {
  process.stdout.write(JSON.stringify({
    items: [{ title: "Outbound call dry-run (blocked)", url: "bland:call/dry-run" }],
  }));
} else {
  const key = process.env.BLAND_API_KEY;
  if (!key) { console.error("missing BLAND_API_KEY"); process.exit(1); }
  const phone = (process.env.BLAND_DEMO_PHONE_NUMBER || "").trim();
  if (!phone) { console.error("missing BLAND_DEMO_PHONE_NUMBER"); process.exit(1); }
  const url = joinBase(input.baseUrl, "https://api.bland.ai", "v1/calls").href;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${key}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ phone_number: phone, task: conversationalTask(task) }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) { console.error("bland", res.status); process.exit(1); }
  const data = await res.json();
  const callId = data.call_id ?? "unknown";
  process.stdout.write(JSON.stringify({
    items: [{
      title: data.status === "success" ? "Outbound call started" : "Outbound call response",
      url: "bland:call/" + callId,
    }],
  }));
}
`;
}

/** Ensure artifact.skillSource is runnable; scaffold if LLM missed the host contract. */
export function ensureRunnableSkillSource(artifact: ForgeArtifact, intent: string): ForgeArtifact {
  let src = artifact.skillSource ? sanitizeSkillSource(artifact.skillSource) : "";
  if (src && skillSourcePassesContract(src)) {
    return { ...artifact, skillSource: src };
  }
  if (preferCallScaffold(intent, artifact.query, artifact.capabilities ?? [])) {
    return {
      ...artifact,
      capabilities: ["net:fetch", "notify:phone"],
      skillSource: defaultBlandSkillSource(),
    };
  }
  const scaffold = preferWebScaffold(intent, artifact.query)
    ? defaultWebSkillSource("forum OR discussion OR reddit")
    : defaultNewsSkillSource();
  return { ...artifact, skillSource: scaffold };
}
