// Shared v4 contracts (SPEC §9, §10, §12, §13). Main session owns this file.

export const ACTORS = ["talk", "forge", "warden", "runner", "broker", "user", "test"] as const;
export type Actor = (typeof ACTORS)[number];

export const LOG_EVENTS = [
  "boot", "job", "gap", "forge", "matched", "precheck", "test", "final", "install", "reuse", "denied", "broken",
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

/** Frozen failureCode enum (SPEC §12). Policy codes → DENIED; build/run codes → Broken. */
export const POLICY_CODES = [
  "charter_pin_mismatch",
  "capability_not_allowed",
  "forbidden_construct",
  "protected_path",
  "secret_in_file",
  "manifest_mismatch",
  "invalid_skill_name",
  "host_not_allowed",
  "hash_mismatch",
] as const;
export const BROKEN_CODES = ["forge_invalid", "test_exit_nonzero", "timeout", "schema_invalid"] as const;
export const FAILURE_CODES = [...POLICY_CODES, ...BROKEN_CODES] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export type PolicyCode = (typeof POLICY_CODES)[number];
export type BrokenCode = (typeof BROKEN_CODES)[number];

/** A capability string from the charter (caps-allow ∪ caps-deny); validated at runtime against it. */
export type Cap = string;

export type LogLine = {
  ts: string;
  actor: Actor;
  event: LogEvent;
  skill: string | null;
  decision: "allow" | "deny" | "pass" | "fail";
  failureCode?: FailureCode;
  charterHash: string;
  caps?: string[];
  voice?: string;
  source?: "live" | "fixture";
  detail?: string;
  tokens?: number;
  costUsd?: number;
  ms?: number;
};

// ── Hands ────────────────────────────────────────────────────────────────

export type Input = {
  name: string; // /^[a-z_]{1,24}$/
  type: "string" | "number";
  format: "text" | "slug";
  required: boolean;
  description: string;
};

export type InputValues = Record<string, string | number>;

export type Item = { title: string; url: string; snippet?: string; date?: string };

/** `emit_recipe` params (SPEC §9 "Recipe forge"). */
export type Recipe = {
  name: string;
  purpose: string;
  endpoint: "news" | "web" | "json";
  queryPattern: string | null;
  site: string | null;
  urlPattern: string | null;
  itemsPath: string | null;
  matchInput: string | null;
  /** json, optional: drop raw items whose number at `field` exceeds the number input `input` (SPEC §9). */
  maxFilter?: { field: string; input: string } | null;
  map: { title: string; url: string; snippet: string | null; date: string | null } | null;
  inputs: Input[];
  example: InputValues;
};

/** The only recipe fields rendered into skill.mjs (`__RECIPE_JSON__`), SPEC §9. */
export type RenderedRecipe = Pick<
  Recipe,
  "endpoint" | "queryPattern" | "site" | "urlPattern" | "itemsPath" | "map" | "matchInput" | "maxFilter"
> & { inputs: Array<Pick<Input, "name" | "type" | "format">> };

export type HandKind = "recipe" | "code" | "hand" | "email_send";

export type Manifest = {
  name: string;
  kind: HandKind;
  purpose: string;
  inputs: Input[];
  capabilities: string[];
  hosts: string[];
  recipe?: Recipe;
};

export type DecisionJson = {
  skill: string;
  kind: HandKind;
  folderHash: string;
  charterHash: string;
  capabilities: string[];
  hosts: string[];
  env: string[];
  inputs: Input[];
  purpose: string;
  forgeTokens: number;
  forgeMs: number;
  decidedAt: string;
};

/** Skill stdin (SPEC §9 "Skill I/O"). User values arrive only here. */
export type SkillStdin = { inputs: InputValues; baseUrl?: string; max?: number };

// ── Jobs, Talk, API ──────────────────────────────────────────────────────

export type Job = {
  skill: string | null;
  intent: string;
  inputs: InputValues;
  needs: Cap[];
  template?: "email_send"; // only on the tripwire Job
};

export type Outcome = "install" | "reuse" | "denied" | "broken";

/** What the Runner returns to Talk's `use_hand` (and to the fixture path). */
export type HandResult = {
  outcome: Outcome;
  skill: string | null;
  failureCode?: FailureCode;
  items?: Item[];
  forgeTokens?: number;
  forgeCostUsd?: number;
  ms?: number;
};

/** Talk's stats at the moment `use_hand` is called (for the `job` line). */
export type TalkStats = { tokens: number; costUsd: number };

export type TalkTokens = { talk: number; forge: number };

/** POST /api/talk response (SPEC §13). */
export type TalkResult =
  | { kind: "chat"; text: string; say?: string }
  | {
      kind: "job";
      job: Job;
      outcome: Outcome;
      skill: string | null;
      failureCode?: FailureCode;
      reply: string;
      items?: Item[];
      tokens?: TalkTokens;
      ms?: number;
      /** Spoken line (SPEC §10 "Voice"); never on denied / broken. */
      say?: string;
    };

/** fixtures/talk/*.json: Talk's `use_hand` call, replayed with Talk skipped (SPEC §10). */
export type TalkFixture = {
  match: string; // normalised user text (JUDGE_MODE lookup)
  useHand: Omit<Job, "template">;
};

/** fixtures/forge/*.json: a recipe replay (OFFLINE / fixture path). */
export type ForgeFixture = {
  match: string[]; // keywords; hit if any appears in the normalised intent
  visited: string[];
  recipe: Recipe;
};

// ── Cross-module signatures (implemented in the named files) ────────────
//
// src/exec.ts
//   runSkill(absSkillPath: string, skillDir: string, stdin: SkillStdin,
//            grant: Record<string, string>, hosts: string[]): Promise<ExecResult>
//   SKILL_TIMEOUT_MS = 15_000; stdout/stderr capped at 1 MiB each (overflow → kill, ok:false).
//
// src/broker.ts
//   BROKER_MAP: Record<string, Cap>            // { BRAVE_API_KEY: "net:fetch" } only
//   brokerGrant(envNames: string[]): Record<string, string>   // values from process.env; {} when OFFLINE=1
//   setProvisionalGrant(runId, envNames) / getProvisionalGrant(runId): string[] / clearProvisionalGrant(runId)
//
// templates/schemas.ts
//   validateOutput(stdout: string): { ok: true; items: Item[] } | { ok: false; reason: string }
//     (reason = short code: "not_json" | "shape" | "no_items" | "no_url")
//
// src/talk.ts
//   talk(text: string, deps: TalkDeps): Promise<TalkOutcome>

export type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  overflow: boolean;
  ms: number;
};

export type TalkDeps = {
  /** Runs the Runner for the first `use_hand` call. */
  runJob: (job: Job, stats: TalkStats) => Promise<HandResult>;
  /** §10 snapshot text (≤20 lines). */
  snapshot: () => string;
  /** LLM time budget; default 45_000. Paused while runJob runs. */
  timeoutMs?: number;
};

export type TalkOutcome =
  | { kind: "chat"; text: string; say?: string; tokens: number; costUsd: number }
  | {
      kind: "job";
      job: Job;
      result: HandResult;
      /** Model-written summary (install/reuse) or the replies.ts template (denied/broken/summary failure). */
      reply: string;
      /** Spoken line: Talk's VOICE: line or the sayFor template; absent on denied / broken. */
      say?: string;
      tokens: number;
      costUsd: number;
    }
  | { kind: "fail"; reason: "talk_failed" | "talk_timeout"; tokens: number; costUsd: number };
