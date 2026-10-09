import type { AgentLoopContext } from "../agent/loop.ts";
import type { AgentAction } from "../agent/types.ts";
import type { ForgeArtifact, ForgeContext } from "../types.ts";

/**
 * Planner backend: turns user/event context into host actions,
 * and freeform Forge into a ForgeArtifact. Host still owns Doctor/Warden/Install.
 */
export type PlannerBackend = {
  planTurn(ctx: AgentLoopContext): Promise<AgentAction[]>;
  forgeSkill(
    intent: string,
    query: string,
    proposedName?: string | null,
    forgeCtx?: ForgeContext | null,
  ): Promise<ForgeArtifact>;
};

export type PlannerName = "pi" | "cursor";

export function resolvePlannerName(): PlannerName {
  const raw = (process.env.PLANNER || "pi").trim().toLowerCase();
  return raw === "cursor" ? "cursor" : "pi";
}
