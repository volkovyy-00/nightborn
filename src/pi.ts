import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type AgentSession,
  type ModelRegistry as ModelRegistryType,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { dataPath } from "./paths.ts";

export type PiModel = NonNullable<ReturnType<ModelRegistryType["find"]>>;

/** SPEC §10: Haiku 4.5 over OpenRouter; Sonnet 4.6 is the abort-ladder swap. */
export const DEFAULT_PI_MODEL = "openrouter/anthropic/claude-haiku-4.5";

export function piAgentDir(): string {
  try {
    const d = getAgentDir();
    if (typeof d === "string" && d.length > 0) return d;
  } catch {
    /* fall through */
  }
  return path.join(homedir(), ".pi", "agent");
}

/** OpenRouter only (SPEC §9 env names). */
export function createPiAuthAndRegistry(): { auth: AuthStorage; registry: ModelRegistry } {
  const auth = AuthStorage.create();
  const or = process.env.OPENROUTER_API_KEY?.trim();
  if (or) auth.setRuntimeApiKey("openrouter", or);
  const registry = ModelRegistry.create(auth);
  return { auth, registry };
}

/** `talk` → PI_MODEL; `forge` → PI_MODEL_FORGE (default: PI_MODEL). */
export function resolvePiModel(registry: ModelRegistry, role: "talk" | "forge" = "talk"): PiModel {
  const talkSpec = process.env.PI_MODEL?.trim() || DEFAULT_PI_MODEL;
  const spec = role === "forge" ? process.env.PI_MODEL_FORGE?.trim() || talkSpec : talkSpec;
  const slash = spec.indexOf("/");
  if (slash === -1) throw new Error("PI_MODEL must be provider/id");
  const model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) throw new Error("PI_MODEL not found in registry");
  return model;
}

/** Pi 0.75 requires cwd + agentDir; undefined cwd throws in normalizePath. */
export function createPiResourceLoader(opts: {
  systemPrompt: string;
  cwd: string;
  extensionFactories?: ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"];
}): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: piAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => opts.systemPrompt,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
    ...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
  });
}

/**
 * Fresh in-memory Pi session with custom tools only (SPEC §10 "Session"). cwd = `staging/`
 * (resolved from process.cwd()); Pi appends cwd + date to the system prompt.
 */
export async function createPiSession(opts: {
  role: "talk" | "forge";
  systemPrompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customTools: ToolDefinition<any, any>[];
  thinkingLevel?: "off" | "low";
  /** Inline extensions, e.g. the Builder's `tool_call` hook (SPEC §9 "Code forge"). */
  extensionFactories?: Parameters<typeof createPiResourceLoader>[0]["extensionFactories"];
}): Promise<AgentSession> {
  const cwd = dataPath("staging");
  mkdirSync(cwd, { recursive: true });
  const { auth, registry } = createPiAuthAndRegistry();
  const model = resolvePiModel(registry, opts.role);
  const loader = createPiResourceLoader({ systemPrompt: opts.systemPrompt, cwd, extensionFactories: opts.extensionFactories });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: piAgentDir(),
    authStorage: auth,
    modelRegistry: registry,
    model,
    thinkingLevel: opts.thinkingLevel ?? "low",
    noTools: "builtin",
    customTools: opts.customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  });
  return session;
}

/**
 * Host-enforced forge limits (SPEC §9): prompt the session; abort at `maxSeconds` or `maxTurns` `turn_end`s
 * unless `isDone()` (the terminating tool ran). `rejected` = prompt() threw (preflight), not a limit.
 */
export async function promptWithLimits(
  session: AgentSession,
  prompt: string,
  limits: { maxTurns: number; maxSeconds: number; isDone: () => boolean },
): Promise<{ limitHit: boolean; rejected: boolean }> {
  let limitHit = false;
  let rejected = false;
  let turns = 0;
  const stop = () => {
    if (limits.isDone()) return;
    limitHit = true;
    void session.abort();
  };
  const timer = setTimeout(stop, limits.maxSeconds * 1000);
  const unsub = session.subscribe((ev) => {
    if (ev.type === "turn_end" && ++turns >= limits.maxTurns) stop();
  });
  try {
    await session.prompt(prompt);
  } catch {
    rejected = !limitHit;
  } finally {
    clearTimeout(timer);
    unsub();
  }
  return { limitHit, rejected };
}

/** Session token/cost totals (aborted mid-stream calls count 0 → lower bound, SPEC §10). */
export function sessionStats(session: AgentSession): { tokens: number; costUsd: number } {
  const s = session.getSessionStats();
  return { tokens: s.tokens.total, costUsd: s.cost };
}
