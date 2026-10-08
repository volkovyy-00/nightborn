/**
 * Agent runtime action types (concrete stubs for wait/resume; loop wire-up in T09).
 */

export type CapabilityBrief = {
  requestId: string;
  goalId: string;
  auditRef: string;
  title: string;
  intent: string;
  /** Human + machine readable contract for minimal success. */
  minimalSuccess: string;
  /** Must ⊆ charter caps when installed. */
  suggestedCaps: string[];
  /** Key into defaults/capabilities.yaml. */
  defaultsHint?: string;
  /** Skill name if this is a patch request. */
  changeOf?: string;
  /** For audit + later eval. */
  why: string;
};

export type ScheduleSpec =
  | { kind: "once"; at: string; goalId: string; note?: string }
  | { kind: "cron"; expr: string; goalId: string; note?: string };

export type AgentAction =
  | { type: "chat"; text: string }
  | {
      type: "run_skill";
      skill: string | null;
      intent: string;
      query: string;
      needs: string[];
    }
  | { type: "request_capability"; brief: CapabilityBrief }
  | { type: "request_capability_change"; skill: string; brief: CapabilityBrief }
  | { type: "write_memory"; path: string; markdown: string }
  | { type: "schedule"; schedule: ScheduleSpec }
  | { type: "wait"; reason: string; requestIds?: string[] };

/** Persisted wait state while Doctor forges capabilities. */
export type ParkedGoal = {
  goalId: string;
  requestIds: string[];
  reason: string;
  satisfiedRequestIds: string[];
  status: "waiting_on_capabilities";
  parkedAt: string;
};
