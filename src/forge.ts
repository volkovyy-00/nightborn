import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ForgeParams } from "./types.ts";
import { repoPath } from "./paths.ts";
import { listSkillDirs } from "./hash.ts";
import { createPiAuthAndRegistry, resolvePiModel } from "./pi.ts";

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

export function renderHttpTemplate(
  params: ForgeParams,
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

export function copyEmailSendTemplate(runDir: string): void {
  mkdirSync(runDir, { recursive: true });
  cpSync(repoPath("templates", "email_send"), runDir, { recursive: true });
}

export async function forgeParamsViaPi(intent: string, query: string): Promise<ForgeParams> {
  let captured: ForgeParams | null = null;

  const emit = defineTool({
    name: "emit_forge_params",
    label: "Emit Forge Params",
    description: "Return params for the frozen http skill template. Call exactly once as your final action.",
    promptGuidelines: [
      "Call emit_forge_params exactly once as your last action.",
      "name: short snake_case skill name",
      "purpose: one sentence",
      "query: search query for the test run",
      "capabilities: include net:fetch",
    ],
    parameters: Type.Object({
      name: Type.String(),
      purpose: Type.String(),
      query: Type.String(),
      capabilities: Type.Array(Type.String()),
    }),
    async execute(_id, params) {
      captured = {
        name: params.name,
        purpose: params.purpose,
        query: params.query,
        capabilities: params.capabilities,
      };
      return {
        content: [{ type: "text", text: `Forged params for ${params.name}` }],
        details: captured,
        terminate: true,
      };
    },
  });

  const { auth, registry } = createPiAuthAndRegistry();
  const model = resolvePiModel(registry);
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () =>
      "You fill params for a frozen HTTP news-search skill template. No code. Call emit_forge_params once.",
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    authStorage: auth,
    modelRegistry: registry,
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [emit],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "emit_forge_params") {
        const d = (event.result as { details?: ForgeParams } | undefined)?.details;
        if (d) captured = d;
      }
    });
    await session.prompt(
      `Create forge params for intent=${JSON.stringify(intent)} query=${JSON.stringify(query)}. Call emit_forge_params.`,
    );
  } finally {
    session.dispose();
  }

  if (!captured) throw new Error("forge_invalid");
  return captured;
}

export function loadForgeFixture(name: string): ForgeParams | null {
  const p = repoPath("fixtures", "forge", name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ForgeParams;
}
