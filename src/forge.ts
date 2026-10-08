import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ForgeArtifact } from "./types.ts";
import { repoPath, REPO_ROOT } from "./paths.ts";
import { listSkillDirs } from "./hash.ts";
import { createPiAuthAndRegistry, createPiResourceLoader, piAgentDir, resolvePiModel } from "./pi.ts";

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

    const caps = artifact.capabilities?.length ? artifact.capabilities : ["net:fetch"];
    const manifest = {
      name: skillName,
      template: "http",
      capabilities: caps.includes("net:fetch") ? caps : ["net:fetch", ...caps],
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
  "You are Nightborn's Forge. Emit one purpose-fit ESM skill via emit_forge_skill.",
  "skillSource = full skill.mjs body (no markdown fences).",
  "Contract:",
  "- Read stdin JSON: { query: string, baseUrl?: string }",
  "- Write stdout JSON: { items: [{ title, url, date? }] } with ≥1 item that has a url",
  "- Use global fetch only; timeout fetches (~6s)",
  "- Env: process.env.BRAVE_API_KEY or TAVILY_API_KEY only (match SEARCH_PROVIDER)",
  "- If baseUrl is set, prefix API paths with it (OFFLINE mock). Build URLs with URL() / join; never string literals starting with a single slash for paths that trip Warden",
  "- Prefer Brave web search for forums/deals/listings: res/v1/web/search",
  "- Prefer Brave news search for company news: res/v1/news/search",
  "- Tailor query shaping to the intent (e.g. add site:reddit.com OR forum for forum asks)",
  "- No eval, new Function, dynamic import(), fs, child_process, nodemailer, email/SMTP",
  "- capabilities usually [\"net:fetch\"]",
  "Call emit_forge_skill exactly once.",
].join("\n");

export async function forgeSkillViaPi(
  intent: string,
  query: string,
  proposedName?: string | null,
): Promise<ForgeArtifact> {
  let captured: ForgeArtifact | null = null;

  const emit = defineTool({
    name: "emit_forge_skill",
    label: "Emit Forge Skill",
    description: "Emit metadata + full skill.mjs source for a new net:fetch skill. Final action.",
    promptGuidelines: [
      "Call emit_forge_skill exactly once as your last action.",
      "skillSource must be complete runnable ESM implementing the stdin/stdout contract.",
      "Pick news vs web Brave endpoint based on intent.",
    ],
    parameters: Type.Object({
      name: Type.String(),
      purpose: Type.String(),
      query: Type.String(),
      capabilities: Type.Array(Type.String()),
      skillSource: Type.String(),
    }),
    async execute(_id, params) {
      captured = {
        name: params.name,
        purpose: params.purpose,
        query: params.query,
        capabilities: params.capabilities,
        skillSource: params.skillSource,
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
    customTools: [emit],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(REPO_ROOT),
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "emit_forge_skill") {
        const d = (event.result as { details?: ForgeArtifact } | undefined)?.details;
        if (d) captured = d;
      }
    });
    const hint = proposedName ? ` proposedName=${JSON.stringify(proposedName)}` : "";
    await session.prompt(
      `Forge a skill for intent=${JSON.stringify(intent)} query=${JSON.stringify(query)}.${hint} Call emit_forge_skill.`,
    );
  } finally {
    session.dispose();
  }

  if (!captured?.skillSource) throw new Error("forge_invalid");
  sanitizeSkillSource(captured.skillSource);
  if (proposedName) captured = { ...captured, name: proposedName };
  return captured;
}

/** @deprecated use forgeSkillViaPi */
export async function forgeParamsViaPi(intent: string, query: string): Promise<ForgeArtifact> {
  return forgeSkillViaPi(intent, query);
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
