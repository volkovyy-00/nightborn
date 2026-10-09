export type Actor =
  | "talk"
  | "forge"
  | "warden"
  | "runner"
  | "broker"
  | "user"
  | "test"
  | "doctor";

export type LogEvent =
  | "boot"
  | "job"
  | "gap"
  | "forge"
  | "matched"
  | "precheck"
  | "test"
  | "final"
  | "install"
  | "reuse"
  | "denied"
  | "broken"
  /** Doctor inbox / progress (receive, working, ready, needs_secret). */
  | "doctor";

export type FailureCode =
  | "charter_pin_mismatch"
  | "capability_not_allowed"
  | "forbidden_construct"
  | "protected_path"
  | "secret_in_file"
  | "manifest_mismatch"
  | "invalid_skill_name"
  | "hash_mismatch"
  | "forge_invalid"
  | "test_exit_nonzero"
  | "timeout"
  | "schema_invalid"
  /** Live Create blocked — only Doctor may install new skills. */
  | "doctor_required";

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
  /** live → surgery.log (UI); fixture → surgery.fixture.log; smoke → surgery.smoke.log */
  source?: "live" | "fixture" | "smoke";
  detail?: string;
};

export type Job = {
  skill: string | null;
  intent: string;
  query: string;
  needs: string[];
  template?: "http" | "email_send";
};

export type TalkResult =
  | { kind: "chat"; text: string }
  | {
      kind: "job";
      job: Job;
      outcome: "install" | "reuse" | "denied" | "broken" | "needs_capability";
      skill: string | null;
      failureCode?: FailureCode;
      reply: string;
    };

/** Skill-scoped Composio binding (host proxy; never puts COMPOSIO_API_KEY in child env). */
export type ComposioSkillBinding = {
  toolkit: string;
  userId: string;
};

/** Create-path Forge artifact. skillSource required on live path; optional for legacy fixtures. */
export type ForgeArtifact = {
  name: string;
  purpose: string;
  query: string;
  capabilities: string[];
  skillSource?: string;
  /** Present when Forge requested/used Composio for this skill. */
  composio?: ComposioSkillBinding;
};

/** @deprecated alias — use ForgeArtifact */
export type ForgeParams = ForgeArtifact;

/** Context for skill-scoped Forge (Doctor passes brief ids + optional hints). */
export type ForgeContext = {
  skillName: string;
  requestId: string;
  goalId: string;
  /** Verbatim user ask — forge prompt line 1 when set. */
  userAsk?: string;
  defaultsHint?: string;
  siteHost?: string;
  minimalSuccess?: string;
  /** Absolute path to durable forge_debug dump dir (set by Doctor when FORGE_DEBUG on). */
  debugDir?: string;
};

export type DecisionJson = {
  skill: string;
  template: "http" | "hand" | "call";
  provider: "tavily" | "brave" | "apify" | null;
  folderHash: string;
  charterHash: string;
  capabilities: string[];
  env: string[];
  decidedAt: string;
  /** Skill-owned Composio session binding (optional). */
  composio?: ComposioSkillBinding;
};

export type Manifest = {
  name: string;
  template: string;
  capabilities: string[];
  outputSchema?: unknown;
};
