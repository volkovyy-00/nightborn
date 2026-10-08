export type Actor =
  | "talk"
  | "forge"
  | "warden"
  | "runner"
  | "broker"
  | "user"
  | "test";

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
  | "broken";

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
  | "schema_invalid";

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
      outcome: "install" | "reuse" | "denied" | "broken";
      skill: string | null;
      failureCode?: FailureCode;
      reply: string;
    };

/** Create-path Forge artifact. skillSource required on live path; optional for legacy fixtures. */
export type ForgeArtifact = {
  name: string;
  purpose: string;
  query: string;
  capabilities: string[];
  skillSource?: string;
};

/** @deprecated alias — use ForgeArtifact */
export type ForgeParams = ForgeArtifact;

export type DecisionJson = {
  skill: string;
  template: "http" | "hand" | "call";
  provider: "tavily" | "brave" | "apify" | null;
  folderHash: string;
  charterHash: string;
  capabilities: string[];
  env: string[];
  decidedAt: string;
};

export type Manifest = {
  name: string;
  template: string;
  capabilities: string[];
  outputSchema?: unknown;
};
