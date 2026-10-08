/**
 * Agent loop — execute action lists from Talk/planner; park/wait; resume on events.
 *
 * Locked MVP: sequential run_skill; multiple request_capability OK; Doctor async
 * (submit + kick, never await Forge on the HTTP turn); MAX_CONTINUE_STEPS default 64
 * (0 = one plan batch only); wall-clock guard via AGENT_WALL_CLOCK_MS.
 */

import { randomBytes } from "node:crypto";
import { append as auditAppend } from "../audit.ts";
import { getDoctor, type CapabilityBrief as DoctorBrief } from "../doctor/index.ts";
import type { RuntimeEvent } from "../events.ts";
import { memoryStore } from "../memory.ts";
import { addSchedule } from "../schedule.ts";
import type { Job, TalkResult } from "../types.ts";
import { parkGoal } from "./park.ts";
import {
  onAgentResume,
  startAgentEventBridge,
  type ResumeContext,
} from "./resume.ts";
import type { AgentAction, CapabilityBrief } from "./types.ts";

export type AgentLoopContext = {
  goalId: string;
  userText?: string;
  event?: RuntimeEvent;
  /** Observations from prior skill runs in this loop (fed back to planner). */
  observations?: string[];
};

export type PlanFn = (ctx: AgentLoopContext) => Promise<AgentAction[]>;
export type RunSkillFn = (job: Job) => Promise<TalkResult>;

export type ExecuteActionsResult = {
  chatTexts: string[];
  skillResults: TalkResult[];
  observations: string[];
  waiting: boolean;
  waitReason?: string;
  requestIds?: string[];
  ranSkill: boolean;
  hadChat: boolean;
  actionsExecuted: number;
};

export type AgentLoopResult = {
  goalId: string;
  status: "chat" | "waiting" | "done" | "budget_exhausted" | "wall_clock";
  text: string;
  skillResults: TalkResult[];
  actionsExecuted: number;
  steps: number;
};

const DEFAULT_MAX_CONTINUE_STEPS = 64;
const DEFAULT_WALL_CLOCK_MS = 120_000;

/** Fresh goal id for a user turn. */
export function newGoalId(_userText?: string): string {
  const ts = Date.now().toString(36);
  const rnd = randomBytes(3).toString("hex");
  return `goal_${ts}_${rnd}`;
}

/**
 * Continue-step budget.
 * - unset → 64
 * - `0` → disable multi-step (one plan→execute batch only)
 * - positive → max plan cycles
 */
export function readMaxContinueSteps(): number {
  const raw = process.env.MAX_CONTINUE_STEPS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_CONTINUE_STEPS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_CONTINUE_STEPS;
  return Math.floor(n);
}

/** Wall-clock guard for a single runAgentLoop invocation (ms). */
export function readWallClockMs(): number {
  const raw = process.env.AGENT_WALL_CLOCK_MS;
  if (raw === undefined || raw === "") return DEFAULT_WALL_CLOCK_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WALL_CLOCK_MS;
  return Math.floor(n);
}

function toDoctorBrief(brief: CapabilityBrief, goalId: string): DoctorBrief {
  return {
    requestId: brief.requestId,
    goalId: brief.goalId || goalId,
    auditRef: brief.auditRef,
    title: brief.title,
    intent: brief.intent,
    minimalSuccess: brief.minimalSuccess,
    suggestedCaps: brief.suggestedCaps,
    ...(brief.defaultsHint !== undefined ? { defaultsHint: brief.defaultsHint } : {}),
    ...(brief.changeOf !== undefined ? { changeOf: brief.changeOf } : {}),
    why: brief.why,
  };
}

function jobFromRunSkill(action: Extract<AgentAction, { type: "run_skill" }>): Job {
  return {
    skill: action.skill,
    intent: action.intent,
    query: action.query,
    needs: action.needs.length ? action.needs : ["net:fetch"],
  };
}

function summarizeSkillResults(results: TalkResult[]): string {
  const parts: string[] = [];
  for (const r of results) {
    if (r.kind === "chat") parts.push(r.text);
    else parts.push(r.reply);
  }
  return parts.filter(Boolean).join("\n\n") || "Done.";
}

/**
 * Execute one batch of actions.
 * - `run_skill`: sequential (one at a time)
 * - `request_capability*`: doctor.submit + audit + kick (non-blocking)
 * - `wait`: parkGoal; does not block Forge
 * - After wait: still run chat / write_memory / schedule / further requests; skip later run_skill
 */
export async function executeActions(
  actions: AgentAction[],
  opts: {
    goalId: string;
    runSkill: RunSkillFn;
  },
): Promise<ExecuteActionsResult> {
  const chatTexts: string[] = [];
  const skillResults: TalkResult[] = [];
  const observations: string[] = [];
  let waiting = false;
  let waitReason: string | undefined;
  let requestIds: string[] | undefined;
  let ranSkill = false;
  let hadChat = false;
  let actionsExecuted = 0;
  let skipSkills = false;

  const doctor = getDoctor();

  for (const action of actions) {
    switch (action.type) {
      case "chat": {
        hadChat = true;
        chatTexts.push(action.text);
        actionsExecuted++;
        break;
      }
      case "run_skill": {
        if (skipSkills) {
          observations.push(`skipped run_skill after wait: ${action.intent}`);
          break;
        }
        const job = jobFromRunSkill(action);
        const result = await opts.runSkill(job);
        skillResults.push(result);
        ranSkill = true;
        actionsExecuted++;
        const reply = result.kind === "chat" ? result.text : result.reply;
        observations.push(
          `run_skill ${result.kind === "job" ? result.skill ?? action.skill ?? "(create)" : "(chat)"}: ${reply}`,
        );
        break;
      }
      case "request_capability": {
        const brief = toDoctorBrief(action.brief, opts.goalId);
        await auditAppend({
          type: "capability.requested",
          goalId: brief.goalId,
          summary: `Requested capability ${brief.title}`,
          why: brief.why,
          data: {
            requestId: brief.requestId,
            title: brief.title,
            suggestedCaps: brief.suggestedCaps,
            defaultsHint: brief.defaultsHint ?? null,
            changeOf: brief.changeOf ?? null,
            auditRef: brief.auditRef,
          },
        });
        // submit enqueues + kick(); does not await Forge/Warden
        await doctor.submit(brief);
        actionsExecuted++;
        observations.push(`requested capability ${brief.requestId} (${brief.title})`);
        break;
      }
      case "request_capability_change": {
        const brief = toDoctorBrief(
          { ...action.brief, changeOf: action.skill },
          opts.goalId,
        );
        await auditAppend({
          type: "capability.change_requested",
          goalId: brief.goalId,
          summary: `Requested change to skill ${action.skill}`,
          why: brief.why,
          data: {
            requestId: brief.requestId,
            skill: action.skill,
            title: brief.title,
            auditRef: brief.auditRef,
          },
        });
        await doctor.requestChange(action.skill, brief);
        actionsExecuted++;
        observations.push(`requested capability change ${brief.requestId} for ${action.skill}`);
        break;
      }
      case "write_memory": {
        await memoryStore.write(action.path, action.markdown);
        actionsExecuted++;
        break;
      }
      case "schedule": {
        await addSchedule(action.schedule);
        actionsExecuted++;
        observations.push(
          `scheduled ${action.schedule.kind} for goal ${action.schedule.goalId}`,
        );
        break;
      }
      case "wait": {
        const ids = action.requestIds ?? [];
        await parkGoal({
          goalId: opts.goalId,
          requestIds: ids,
          reason: action.reason,
        });
        await auditAppend({
          type: "agent.wait",
          goalId: opts.goalId,
          summary: `Parked: ${action.reason}`,
          why: action.reason,
          data: { requestIds: ids },
        });
        waiting = true;
        waitReason = action.reason;
        requestIds = ids;
        skipSkills = true;
        actionsExecuted++;
        break;
      }
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
        break;
      }
    }
  }

  return {
    chatTexts,
    skillResults,
    observations,
    waiting,
    waitReason,
    requestIds,
    ranSkill,
    hadChat,
    actionsExecuted,
  };
}

/**
 * Plan → execute loop with continue budget.
 * Stops on wait, pure chat, terminal chat-after-skills, empty plan, budget, or wall-clock.
 */
export async function runAgentLoop(
  ctx: AgentLoopContext,
  deps: { plan: PlanFn; runSkill: RunSkillFn },
): Promise<AgentLoopResult> {
  const maxSteps = readMaxContinueSteps();
  const wallMs = readWallClockMs();
  const started = Date.now();
  let steps = 0;
  let actionsExecuted = 0;
  const observations = [...(ctx.observations ?? [])];
  const skillResults: TalkResult[] = [];
  let lastChat = "";

  while (true) {
    if (Date.now() - started > wallMs) {
      return {
        goalId: ctx.goalId,
        status: "wall_clock",
        text: lastChat || summarizeSkillResults(skillResults) || "Stopped on wall-clock guard.",
        skillResults,
        actionsExecuted,
        steps,
      };
    }

    // maxSteps === 0 → only the first plan batch (disable multi-step continues)
    if (maxSteps === 0 && steps >= 1) {
      return {
        goalId: ctx.goalId,
        status: "done",
        text: lastChat || summarizeSkillResults(skillResults),
        skillResults,
        actionsExecuted,
        steps,
      };
    }
    if (maxSteps > 0 && steps >= maxSteps) {
      return {
        goalId: ctx.goalId,
        status: "budget_exhausted",
        text: lastChat || summarizeSkillResults(skillResults) || "Continue-step budget exhausted.",
        skillResults,
        actionsExecuted,
        steps,
      };
    }

    const actions = await deps.plan({
      goalId: ctx.goalId,
      userText: ctx.userText,
      event: ctx.event,
      observations: [...observations],
    });
    steps++;

    if (!actions.length) {
      return {
        goalId: ctx.goalId,
        status: "done",
        text: lastChat || summarizeSkillResults(skillResults) || "Done.",
        skillResults,
        actionsExecuted,
        steps,
      };
    }

    const exec = await executeActions(actions, {
      goalId: ctx.goalId,
      runSkill: deps.runSkill,
    });
    actionsExecuted += exec.actionsExecuted;
    skillResults.push(...exec.skillResults);
    observations.push(...exec.observations);
    if (exec.chatTexts.length) {
      lastChat = exec.chatTexts[exec.chatTexts.length - 1]!;
    }

    if (exec.waiting) {
      const ids = exec.requestIds?.length ? ` [${exec.requestIds.join(", ")}]` : "";
      return {
        goalId: ctx.goalId,
        status: "waiting",
        text:
          lastChat ||
          `Working / waiting on capabilities: ${exec.waitReason ?? "capabilities"}${ids}`,
        skillResults,
        actionsExecuted,
        steps,
      };
    }

    // Pure chat (or chat with memory/schedule only) → terminal
    if (exec.hadChat && !exec.ranSkill) {
      return {
        goalId: ctx.goalId,
        status: "chat",
        text: lastChat,
        skillResults,
        actionsExecuted,
        steps,
      };
    }

    // Skill(s) + chat in same batch → terminal reply
    if (exec.hadChat && exec.ranSkill) {
      return {
        goalId: ctx.goalId,
        status: "done",
        text: lastChat || summarizeSkillResults(skillResults),
        skillResults,
        actionsExecuted,
        steps,
      };
    }

    // Skills only → continue another plan if budget allows
    if (exec.ranSkill) {
      if (maxSteps === 0) {
        return {
          goalId: ctx.goalId,
          status: "done",
          text: lastChat || summarizeSkillResults(skillResults),
          skillResults,
          actionsExecuted,
          steps,
        };
      }
      // Clear one-shot userText/event after first plan so continues use observations
      ctx = { goalId: ctx.goalId, observations: [...observations] };
      continue;
    }

    // Non-skill side effects only (memory / schedule / capability requests without wait)
    return {
      goalId: ctx.goalId,
      status: "done",
      text: lastChat || "Working.",
      skillResults,
      actionsExecuted,
      steps,
    };
  }
}

export type WireResumeDeps = {
  plan: PlanFn;
  runSkill: RunSkillFn;
  /** Optional: surface resume reply (history / log). */
  onResult?: (result: AgentLoopResult, resume: ResumeContext) => void | Promise<void>;
};

/**
 * Start event bridge and register resume → another agent turn with `event` set (no user text).
 * Idempotent bridge; returns unsubscribe for the resume handler.
 */
export function wireAgentResume(deps: WireResumeDeps): () => void {
  startAgentEventBridge();
  return onAgentResume(async (resume) => {
    try {
      const result = await runAgentLoop(
        { goalId: resume.goalId, event: resume.event },
        { plan: deps.plan, runSkill: deps.runSkill },
      );
      if (deps.onResult) await deps.onResult(result, resume);
    } catch (err) {
      console.error("[agent/loop] resume turn failed", resume.goalId, err);
    }
  });
}
