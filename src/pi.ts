import {
  AuthStorage,
  ModelRegistry,
  type ModelRegistry as ModelRegistryType,
} from "@earendil-works/pi-coding-agent";

export type PiModel = NonNullable<ReturnType<ModelRegistryType["find"]>>;

/** Cheap paid default — avoid :free OpenRouter models (rate limits). */
export const DEFAULT_PI_MODEL = "openrouter/openai/gpt-4o-mini";

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
