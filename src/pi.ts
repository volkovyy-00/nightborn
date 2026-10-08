import { homedir } from "node:os";
import path from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  getAgentDir,
  type ModelRegistry as ModelRegistryType,
} from "@earendil-works/pi-coding-agent";
import { REPO_ROOT } from "./paths.ts";

export type PiModel = NonNullable<ReturnType<ModelRegistryType["find"]>>;

/** Cheap paid default — avoid :free OpenRouter models (rate limits). */
export const DEFAULT_PI_MODEL = "openrouter/openai/gpt-4o-mini";

export function piAgentDir(): string {
  try {
    const d = getAgentDir();
    if (typeof d === "string" && d.length > 0) return d;
  } catch {
    /* fall through */
  }
  return path.join(homedir(), ".pi", "agent");
}

export function createPiAuthAndRegistry(): { auth: AuthStorage; registry: ModelRegistry } {
  const auth = AuthStorage.create();
  const or = process.env.OPENROUTER_API_KEY?.trim();
  if (or) auth.setRuntimeApiKey("openrouter", or);
  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) auth.setRuntimeApiKey("openai", openai);
  const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) auth.setRuntimeApiKey("anthropic", anthropic);
  const registry = ModelRegistry.create(auth);
  return { auth, registry };
}

export function resolvePiModel(registry: ModelRegistry): PiModel {
  const spec = process.env.PI_MODEL?.trim() || DEFAULT_PI_MODEL;
  const slash = spec.indexOf("/");
  if (slash === -1) throw new Error(`PI_MODEL must be provider/id, got ${spec}`);
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const model = registry.find(provider, id);
  if (!model) throw new Error(`Model not found: ${spec}`);
  return model;
}

/** Pi 0.75 requires cwd + agentDir; undefined cwd throws in normalizePath. */
export function createPiResourceLoader(opts: {
  systemPrompt: string;
}): DefaultResourceLoader {
  const cwd = REPO_ROOT;
  const agentDir = piAgentDir();
  if (!cwd || !agentDir) {
    throw new Error(`Pi paths missing cwd=${cwd} agentDir=${agentDir}`);
  }
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => opts.systemPrompt,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
  });
}
