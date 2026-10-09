/**
 * Pi planner backend — existing @earendil-works/pi-coding-agent tool sessions.
 */

import type { AgentLoopContext } from "../agent/loop.ts";
import type { AgentAction } from "../agent/types.ts";
import type { ForgeArtifact, ForgeContext } from "../types.ts";
import type { PlannerBackend } from "./types.ts";

export const piPlanner: PlannerBackend = {
  async planTurn(ctx: AgentLoopContext): Promise<AgentAction[]> {
    const { planAgentTurnViaPi } = await import("../talk.ts");
    return planAgentTurnViaPi(ctx);
  },

  async forgeSkill(
    intent: string,
    query: string,
    proposedName?: string | null,
    forgeCtx?: ForgeContext | null,
  ): Promise<ForgeArtifact> {
    const { forgeSkillViaPi } = await import("../forge.ts");
    return forgeSkillViaPi(intent, query, proposedName, forgeCtx);
  },
};
