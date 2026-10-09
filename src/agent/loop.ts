/**
 * Agent loop — execute action lists from Talk/planner; park/wait; resume on events.
 *
 * Locked MVP: sequential run_skill; multiple request_capability OK; Doctor async
 * (submit + kick, never await Forge on the HTTP turn); MAX_CONTINUE_STEPS default 64
 * (0 = one plan batch only); wall-clock guard via AGENT_WALL_CLOCK_MS.
 */

import { randomBytes } from "node:crypto";
import { append as auditAppend } from "../audit.ts";
import { getCharterHash } from "../charter.ts";
import {
  executeComposioTool,
  newAccessRequestId,
  requestToolkitAccess,
} from "../composio.ts";
import { getDoctor, type CapabilityBrief as DoctorBrief } from "../doctor/index.ts";
import type { RuntimeEvent } from "../events.ts";
import { appendLog } from "../log.ts";
import { synthesizeDealsReply } from "../listings.ts";
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

/** Surgery-log job+gap so the UI shows recognized gap / growing limb for Doctor work. */
function logDoctorGapForUi(skill: string | null, query: string, why: string): void {
  appendLog({
    actor: "talk",
    event: "job",
    skill,
    decision: "allow",
    charterHash: getCharterHash(),
    detail: query || "request_capability",
  });
  appendLog({
    actor: "runner",
    event: "gap",
    skill,
    decision: "allow",
    failureCode: "doctor_required",
    charterHash: getCharterHash(),
    detail: `recognized gap · Doctor growing · ${why.slice(0, 120)}`,
  });
}

/** Snake_case skill / request title from intent or named skill. */
export function skillTitleFromJob(job: Job): string {
  if (job.skill && /^[a-z][a-z0-9_]*$/.test(job.skill)) return job.skill;
  const slug = job.intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
  return slug || "new_capability";
}

/** Defaults registry hint from job caps / intent (Doctor consults before inventing APIs). */
export function defaultsHintFromJob(job: Job): string {
  const needs = job.needs ?? [];
  if (needs.includes("notify:phone")) return "voice.outbound_bland";
  const blob = `${job.intent} ${job.query} ${job.skill ?? ""}`.toLowerCase();
  if (/\b(list|listing|scrape|marketplace|deal|cars?\.com|edmunds|cargurus)\b/.test(blob)) {
    return "listings.http_scrape";
  }
  return "search.web";
}

/** Synthesize a Doctor brief when live Create was blocked (`doctor_required`). */
export function briefFromBlockedJob(job: Job, goalId: string): CapabilityBrief {
  const title = skillTitleFromJob(job);
  const stamp = Date.now().toString(36);
  const rnd = randomBytes(3).toString("hex");
  const caps = job.needs.length ? job.needs : ["net:fetch"];
  const hint = defaultsHintFromJob(job);
  return {
    requestId: `req_${title}_${stamp}_${rnd}`.slice(0, 80),
    goalId,
    auditRef: `aud_auto_${stamp}_${rnd}`,
    title,
    intent: job.intent,
    minimalSuccess:
      'stdin {query} → stdout { "items": [{ "title", "url", "date?" }] }',
    suggestedCaps: caps,
    defaultsHint: hint,
    why: `Live Create blocked for "${title}"; routing through Doctor (${hint}). Query: ${job.query}`,
  };
}

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
    ...(brief.userAsk !== undefined ? { userAsk: brief.userAsk } : {}),
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

/** True when a plan cannot advance the goal (empty wait / no work). */
export function isNoopPlan(actions: AgentAction[]): boolean {
  if (!actions.length) return true;
  let sawWork = false;
  for (const a of actions) {
    if (a.type === "chat" && a.text.trim()) return false;
    if (a.type === "run_skill" || a.type === "run_composio_tool") return false;
    if (
      a.type === "request_capability" ||
      a.type === "request_capability_change" ||
      a.type === "request_access"
    ) {
      sawWork = true;
      continue;
    }
    if (a.type === "wait") {
      if ((a.requestIds?.length ?? 0) > 0 || sawWork) return false;
      continue;
    }
    if (a.type === "write_memory" || a.type === "schedule") return false;
  }
  return true;
}

type ListingSurface = { key: string; title: string; label: string };

/** Surfaces mentioned in user text for used-car / listings goals. */
export function listingSurfacesFromText(userText: string): ListingSurface[] {
  const t = userText.toLowerCase();
  const out: ListingSurface[] = [];
  const add = (key: string, title: string, label: string, re: RegExp) => {
    if (re.test(t) && !out.some((s) => s.key === key)) out.push({ key, title, label });
  };
  add("cars_com", "scrape_cars_com", "Cars.com", /cars\.com/);
  add("edmunds", "scrape_edmunds", "Edmunds", /edmunds/);
  add("cargurus", "scrape_cargurus", "CarGurus", /cargurus/);
  add("autotrader", "scrape_autotrader", "Autotrader", /autotrader/);
  if (
    out.length === 0 &&
    /\b(used[- ]?cars?|listings?|deals?|marketplace)\b/.test(t)
  ) {
    out.push({
      key: "used_car_listings",
      title: "scrape_used_car_listings",
      label: "used-car listing surfaces",
    });
  }
  // Facebook Market(place) shorthand — growth surface, not cars.com remap.
  if (
    out.length === 0 &&
    (/\bfacebook\b/.test(t) || /\bfb\b/.test(t) || /\bfacebook\s+market\b/.test(t))
  ) {
    out.push({
      key: "facebook_marketplace",
      title: "facebook_marketplace",
      label: "Facebook Marketplace",
    });
  }
  return out;
}

/** Pull a usable scrape query from the user ask (price cap, make, etc.). */
export function scrapeQueryFromUserText(userText: string): string {
  const t = userText.trim();
  const under = t.match(/under\s*\$?\s*([\d,]+)\s*(k\b)?/i);
  const make = t.match(
    /\b(bmw|toyota|honda|ford|chevy|chevrolet|tesla|audi|mercedes|nissan|hyundai|kia|mazda|subaru|volkswagen|vw)\b/i,
  );
  let budget = "";
  if (under) {
    const n = Number(under[1]!.replace(/,/g, ""));
    const dollars = under[2] ? n * 1000 : n;
    if (Number.isFinite(dollars) && dollars > 0) budget = `under ${dollars}`;
  }
  const parts = ["used cars"];
  if (make) parts[0] = make[1]!;
  if (budget) parts.push(budget);
  else {
    const clipped = t
      .replace(/look at|give me|the best deals?|used-?car listings?|on \S+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (clipped.length > 3 && clipped.length < 80) return clipped;
  }
  return parts.join(" ").trim() || "used cars under 10000";
}

/** True when user text looks like a growth / fetch ask (not pure chat). */
export function looksLikeGrowthAsk(userText: string): boolean {
  const t = userText.toLowerCase();
  if (listingSurfacesFromText(userText).length > 0) return true;
  // Include facebook / "facebook market" (users often omit "place") and used cars plural.
  return /\b(used[- ]?cars?|listings?|deals?|marketplace|facebook|\bfb\b|scrape|fetch|find|get|search|pull)\b/.test(
    t,
  );
}

/**
 * Last-resort host brief: preserve the user ask verbatim — no surface remap, no cars.com.
 */
export function hostPreserveUserAskBrief(userText: string, goalId: string): AgentAction[] {
  const text = userText.trim();
  if (!text) return [];
  const stamp = Date.now().toString(36);
  const rnd = randomBytes(2).toString("hex");
  const requestId = `req_userask_${stamp}_${rnd}`;
  const slug =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40) || "user_ask";
  const title = `cap_${slug}`;
  return [
    {
      type: "request_capability",
      brief: {
        requestId,
        goalId,
        auditRef: `aud_userask_${stamp}`,
        title,
        intent: text,
        minimalSuccess: `Satisfy the user ask: ${text}`,
        suggestedCaps: ["net:fetch"],
        userAsk: text,
        why: text,
      },
    },
    {
      type: "wait",
      reason: "Doctor forging for user ask",
      requestIds: [requestId],
    },
    {
      type: "chat",
      text: "Recognized gap — Doctor growing a hand for your ask.",
    },
  ];
}

/** Read scrape query persisted under memory/goals/<goalId>.md. */
export async function loadGoalQuery(goalId: string): Promise<string | null> {
  const raw = await memoryStore.read(`goals/${goalId}.md`);
  if (!raw) return null;
  const m = raw.match(/^query:\s*(.+)\s*$/m);
  return m?.[1]?.trim() || null;
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
    /** Current user turn — fills brief.userAsk when the planner omitted it. */
    userText?: string;
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
  /** requestIds submitted in this batch — fill wait if the planner omits them. */
  const pendingRequestIds: string[] = [];

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
        if (!job.query.trim()) {
          const q = await loadGoalQuery(opts.goalId);
          if (q) job.query = q;
        }
        const result = await opts.runSkill(job);
        skillResults.push(result);
        ranSkill = true;
        actionsExecuted++;
        const reply = result.kind === "chat" ? result.text : result.reply;
        observations.push(
          `run_skill ${result.kind === "job" ? result.skill ?? action.skill ?? "(create)" : "(chat)"}: ${reply}`,
        );

        // Live Create blocked → enqueue Doctor + park (same as explicit wait).
        if (
          result.kind === "job" &&
          result.outcome === "needs_capability" &&
          result.failureCode === "doctor_required"
        ) {
          const blocked = briefFromBlockedJob(job, opts.goalId);
          const brief =
            opts.userText?.trim() && !blocked.userAsk
              ? { ...blocked, userAsk: opts.userText.trim() }
              : blocked;
          const doctorBrief = toDoctorBrief(brief, opts.goalId);
          await auditAppend({
            type: "capability.requested",
            goalId: doctorBrief.goalId,
            summary: `Auto-routed Create → Doctor for ${doctorBrief.title}`,
            why: doctorBrief.why,
            data: {
              requestId: doctorBrief.requestId,
              title: doctorBrief.title,
              suggestedCaps: doctorBrief.suggestedCaps,
              defaultsHint: doctorBrief.defaultsHint ?? null,
              auditRef: doctorBrief.auditRef,
              source: "doctor_required",
            },
          });
          await doctor.submit(doctorBrief);
          await parkGoal({
            goalId: opts.goalId,
            requestIds: [doctorBrief.requestId],
            reason: `Doctor forging ${doctorBrief.title}`,
          });
          await auditAppend({
            type: "agent.wait",
            goalId: opts.goalId,
            summary: `Parked after doctor_required: ${doctorBrief.title}`,
            why: doctorBrief.why,
            data: { requestIds: [doctorBrief.requestId] },
          });
          waiting = true;
          waitReason = `Doctor forging ${doctorBrief.title}`;
          requestIds = [doctorBrief.requestId];
          skipSkills = true;
          observations.push(
            `doctor_required → requested ${doctorBrief.requestId} (${doctorBrief.title}) and parked`,
          );
        }
        break;
      }
      case "request_capability": {
        const withAsk =
          !action.brief.userAsk?.trim() && opts.userText?.trim()
            ? { ...action.brief, userAsk: opts.userText.trim() }
            : action.brief;
        const brief = toDoctorBrief(withAsk, opts.goalId);
        logDoctorGapForUi(brief.title, brief.intent, brief.why);
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
        pendingRequestIds.push(brief.requestId);
        actionsExecuted++;
        observations.push(`requested capability ${brief.requestId} (${brief.title})`);
        break;
      }
      case "request_capability_change": {
        const withAsk =
          !action.brief.userAsk?.trim() && opts.userText?.trim()
            ? { ...action.brief, userAsk: opts.userText.trim() }
            : action.brief;
        const brief = toDoctorBrief(
          { ...withAsk, changeOf: action.skill },
          opts.goalId,
        );
        logDoctorGapForUi(action.skill, brief.intent, brief.why);
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
        pendingRequestIds.push(brief.requestId);
        actionsExecuted++;
        observations.push(`requested capability change ${brief.requestId} for ${action.skill}`);
        break;
      }
      case "request_access": {
        // Escape hatch: scope to a synthetic skill name from toolkit (Forge path is primary).
        const requestId =
          action.requestId?.trim() || newAccessRequestId(action.toolkit);
        const skillName = `talk_${action.toolkit}`.replace(/[^a-z0-9_]/gi, "_").slice(0, 48);
        const result = await requestToolkitAccess({
          toolkit: action.toolkit,
          requestId,
          goalId: opts.goalId,
          skillName,
          why: action.why,
        });
        await auditAppend({
          type: "access.requested",
          goalId: opts.goalId,
          summary: result.ok
            ? `Requested Composio access to ${result.toolkit} (skill ${skillName})`
            : `Composio access denied/failed for ${action.toolkit}`,
          why: action.why,
          data: {
            requestId: result.requestId,
            toolkit: result.toolkit || action.toolkit,
            skillName,
            ok: result.ok,
            ...(result.ok
              ? {
                  redirectUrl: result.redirectUrl,
                  alreadyConnected: result.alreadyConnected,
                }
              : { code: result.code, message: result.message }),
          },
        });
        if (!result.ok) {
          chatTexts.push(result.message);
          hadChat = true;
          observations.push(
            `request_access failed ${result.requestId}: ${result.code} ${result.message}`,
          );
          actionsExecuted++;
          break;
        }
        if (result.alreadyConnected) {
          observations.push(
            `request_access ${result.requestId}: ${result.toolkit} already connected`,
          );
        } else {
          const linkNote = result.redirectUrl
            ? ` Connect: ${result.redirectUrl}`
            : "";
          chatTexts.push(
            `Need Composio access to ${result.toolkit}.${linkNote}`,
          );
          hadChat = true;
          pendingRequestIds.push(result.requestId);
          observations.push(
            `request_access ${result.requestId} toolkit=${result.toolkit} waiting on Connect Link`,
          );
        }
        actionsExecuted++;
        break;
      }
      case "run_composio_tool": {
        if (skipSkills) {
          observations.push(`skipped run_composio_tool after wait: ${action.intent}`);
          break;
        }
        const exec = await executeComposioTool(action.tool, action.arguments ?? {});
        actionsExecuted++;
        if (exec.ok) {
          const preview = JSON.stringify(exec.data).slice(0, 1500);
          observations.push(`run_composio_tool ${exec.tool} ok logId=${exec.logId}: ${preview}`);
          chatTexts.push(`Composio ${exec.tool}: ${preview}`);
          hadChat = true;
        } else {
          observations.push(`run_composio_tool ${exec.tool} failed: ${exec.error}`);
          chatTexts.push(`Composio tool failed (${exec.tool}): ${exec.error}`);
          hadChat = true;
        }
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
        const ids =
          action.requestIds && action.requestIds.length > 0
            ? action.requestIds
            : [...pendingRequestIds];
        // Empty wait with nothing enqueued is a planner no-op — do not fake a park.
        if (ids.length === 0) {
          observations.push(
            "ignored wait with empty requestIds (request_capability / request_access first, then wait with those ids)",
          );
          actionsExecuted++;
          break;
        }
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

  // Planner requested capabilities but omitted wait — still park so resume can wake.
  if (!waiting && pendingRequestIds.length > 0) {
    await parkGoal({
      goalId: opts.goalId,
      requestIds: [...pendingRequestIds],
      reason: `Waiting on ${pendingRequestIds.length} capabilities`,
    });
    await auditAppend({
      type: "agent.wait",
      goalId: opts.goalId,
      summary: `Auto-parked after request_capability/request_access without wait`,
      why: "host auto-park",
      data: { requestIds: [...pendingRequestIds] },
    });
    waiting = true;
    waitReason = `Waiting on ${pendingRequestIds.length} capabilities/access`;
    requestIds = [...pendingRequestIds];
    observations.push(
      `auto-parked on [${pendingRequestIds.join(", ")}] (request without wait)`,
    );
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

    let actions = await deps.plan({
      goalId: ctx.goalId,
      userText: ctx.userText,
      event: ctx.event,
      observations: [...observations],
    });
    steps++;

    const hasCapOrSkill = (acts: AgentAction[]) =>
      acts.some(
        (a) =>
          a.type === "request_capability" ||
          a.type === "request_capability_change" ||
          a.type === "run_skill",
      );

    // One replan if the model only emitted an empty wait / no-op batch on a user turn.
    if (ctx.userText && isNoopPlan(actions) && maxSteps !== 0) {
      const listingHint = looksLikeGrowthAsk(ctx.userText)
        ? ` Emit request_capability with userAsk equal to the exact user message (${JSON.stringify(ctx.userText)}). Do not invent cars.com.`
        : "";
      observations.push(
        "Previous plan was a no-op (wait without requestIds / no request_capability). " +
          "Emit request_capability briefs (defaultsHint when known) then wait with those requestIds." +
          listingHint,
      );
      actions = await deps.plan({
        goalId: ctx.goalId,
        userText: ctx.userText,
        event: ctx.event,
        observations: [...observations],
      });
      steps++;
    }
    // Forced Pi replan: growth ask with still no request_capability / run_skill.
    if (
      ctx.userText &&
      maxSteps !== 0 &&
      looksLikeGrowthAsk(ctx.userText) &&
      !hasCapOrSkill(actions)
    ) {
      observations.push(
        `FORCE: emit request_capability now; userAsk must equal the user message verbatim: ${JSON.stringify(ctx.userText)}. Do not invent cars.com.`,
      );
      actions = await deps.plan({
        goalId: ctx.goalId,
        userText: ctx.userText,
        event: ctx.event,
        observations: [...observations],
      });
      steps++;
    }
    // Last resort: preserve userAsk — no surface remap / listings.http_scrape / cars.com.
    if (
      ctx.userText &&
      looksLikeGrowthAsk(ctx.userText) &&
      !hasCapOrSkill(actions)
    ) {
      const fb = hostPreserveUserAskBrief(ctx.userText, ctx.goalId);
      if (fb.length) {
        observations.push(
          "hostPreserveUserAskBrief: Talk had no request_capability/run_skill — brief copies userText verbatim",
        );
        actions = fb;
      }
    }

    // Inject userAsk on capability briefs when the planner omitted it.
    if (ctx.userText) {
      actions = actions.map((a) => {
        if (
          (a.type === "request_capability" || a.type === "request_capability_change") &&
          !a.brief.userAsk?.trim()
        ) {
          return { ...a, brief: { ...a.brief, userAsk: ctx.userText!.trim() } };
        }
        return a;
      });
    }

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
      userText: ctx.userText,
    });
    actionsExecuted += exec.actionsExecuted;
    skillResults.push(...exec.skillResults);
    observations.push(...exec.observations);
    await auditAppend({
      type: "agent.plan",
      goalId: ctx.goalId,
      summary: `Plan batch: ${actions.map((a) => a.type).join(", ") || "(empty)"}`,
      data: {
        types: actions.map((a) => a.type),
        waiting: exec.waiting,
        requestIds: exec.requestIds ?? [],
        actionsExecuted: exec.actionsExecuted,
      },
    });
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

    // Resume turn: one skill run then stop (do not hand off to Pi).
    // When allSatisfied, host-rank listings into a real deals reply.
    if (exec.ranSkill && ctx.event?.type === "capability.ready") {
      const allSatisfied = observations.includes("allSatisfied:true");
      if (allSatisfied) {
        const q =
          observations.find((o) => o.startsWith("query:"))?.slice("query:".length).trim() ||
          (await loadGoalQuery(ctx.goalId)) ||
          "used cars under 10000";
        const deals = await synthesizeDealsReply(ctx.goalId, q);
        try {
          const raw = await memoryStore.read(`goals/${ctx.goalId}.md`);
          if (raw) {
            await memoryStore.write(
              `goals/${ctx.goalId}.md`,
              raw.replace(/^status:\s*.+$/m, "status: done"),
            );
          }
        } catch {
          /* best-effort */
        }
        return {
          goalId: ctx.goalId,
          status: "done",
          text: deals,
          skillResults,
          actionsExecuted,
          steps,
        };
      }
      return {
        goalId: ctx.goalId,
        status: "done",
        text: summarizeSkillResults(skillResults),
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
  /** Resume runs pass goalId so Reuse can append transcript status. */
  runSkill: (job: Job, goalId: string) => Promise<TalkResult>;
  /** Optional: fire before the resume loop (UI status: “Running …”). */
  onStart?: (resume: ResumeContext) => void | Promise<void>;
  /** Optional: surface resume reply (history / log / UI). */
  onResult?: (result: AgentLoopResult, resume: ResumeContext) => void | Promise<void>;
};

async function runWakeTurn(deps: WireResumeDeps, wake: ResumeContext): Promise<void> {
  if (deps.onStart) await deps.onStart(wake);
  const q = await loadGoalQuery(wake.goalId);
  const observations = [
    ...(q ? [`query:${q}`] : []),
    wake.allSatisfied
      ? "allSatisfied:true"
      : `remaining:${wake.remainingRequestIds.join(",")}`,
  ];
  const result = await runAgentLoop(
    { goalId: wake.goalId, event: wake.event, observations },
    {
      plan: deps.plan,
      runSkill: (job) => deps.runSkill(job, wake.goalId),
    },
  );
  if (deps.onResult) await deps.onResult(result, wake);
}

/**
 * Start event bridge and register wake → another agent turn with `event` set (no user text).
 * Idempotent bridge; returns unsubscribe for the wake handler.
 * Heavy work is queued so Doctor `emit` is not blocked by skill latency.
 */
export function wireAgentResume(deps: WireResumeDeps): () => void {
  startAgentEventBridge();
  return onAgentResume((wake) => {
    setImmediate(() => {
      void runWakeTurn(deps, wake).catch((err) => {
        console.error("[agent/loop] wake turn failed", wake.goalId, err);
      });
    });
  });
}
