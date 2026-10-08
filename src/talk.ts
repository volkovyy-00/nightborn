import { readFileSync, existsSync, readdirSync } from "node:fs";
import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ForgeArtifact, Job } from "./types.ts";
import { repoPath, dataPath, REPO_ROOT } from "./paths.ts";
import { listSkillDirs } from "./hash.ts";
import { ALLOWED_CAPS } from "./charter.ts";
import { createPiAuthAndRegistry, createPiResourceLoader, piAgentDir, resolvePiModel } from "./pi.ts";
import type { AgentAction, CapabilityBrief } from "./agent/types.ts";
import type { AgentLoopContext } from "./agent/loop.ts";
import type { RuntimeEvent } from "./events.ts";

export type TalkEmit =
  | { kind: "chat"; text: string }
  | { kind: "job"; text: string; job: Job };

type Turn = { role: "user" | "assistant"; text: string };

const history: Turn[] = [];

export function pushHistory(role: "user" | "assistant", text: string): void {
  history.push({ role, text });
  while (history.length > 10) history.shift();
}

function snapshot(): string {
  const names = listSkillDirs(dataPath("skills")).filter((n) => n !== "hand_probe");
  return [
    `Capabilities (needs may only use these): ${ALLOWED_CAPS.join(", ")}`,
    `Installed skills: ${names.length ? names.join(", ") : "(none)"}`,
    "Same kind of job as an installed skill (e.g. another company news): skill=null → Reuse.",
    "Different job (forums, deals, listings) or grow/forge/don't reuse X: skill=new_snake_case NOT installed → Create (free-form Forge) via run_skill, OR request_capability for Doctor.",
    "Never set skill to hand_probe.",
  ].join("\n");
}

function normalizeSkill(skill: string | null | undefined): string | null {
  if (
    !skill ||
    skill === "hand_probe" ||
    skill === "null" ||
    skill === "undefined" ||
    (ALLOWED_CAPS as readonly string[]).includes(skill)
  ) {
    return null;
  }
  return skill;
}

function filterNeeds(needs: string[] | undefined): string[] {
  const filtered = (needs ?? []).filter((n) => (ALLOWED_CAPS as readonly string[]).includes(n));
  return filtered.length ? filtered : ["net:fetch"];
}

/** Map legacy TalkEmit → action list for the host loop. */
export function talkEmitToActions(emit: TalkEmit): AgentAction[] {
  if (emit.kind === "chat") return [{ type: "chat", text: emit.text }];
  return [
    {
      type: "run_skill",
      skill: emit.job.skill,
      intent: emit.job.intent,
      query: emit.job.query,
      needs: emit.job.needs.length ? emit.job.needs : ["net:fetch"],
    },
  ];
}

function briefFromParams(params: {
  requestId: string;
  goalId: string;
  auditRef: string;
  title: string;
  intent: string;
  minimalSuccess: string;
  suggestedCaps: string[];
  why: string;
  defaultsHint?: string;
  changeOf?: string;
}): CapabilityBrief {
  const brief: CapabilityBrief = {
    requestId: params.requestId,
    goalId: params.goalId,
    auditRef: params.auditRef,
    title: params.title,
    intent: params.intent,
    minimalSuccess: params.minimalSuccess,
    suggestedCaps: filterNeeds(params.suggestedCaps),
    why: params.why,
  };
  if (params.defaultsHint) brief.defaultsHint = params.defaultsHint;
  if (params.changeOf) brief.changeOf = params.changeOf;
  return brief;
}

/**
 * Heuristic plan when the model is unavailable or returns nothing on resume.
 * capability.ready → run the installed skill once.
 */
export function fallbackPlanFromEvent(
  ctx: AgentLoopContext,
): AgentAction[] {
  const event = ctx.event;
  if (!event) return [];
  if (event.type === "capability.ready") {
    const query =
      ctx.observations?.find((o) => o.startsWith("query:"))?.slice("query:".length).trim() ||
      "continue";
    return [
      {
        type: "run_skill",
        skill: event.skill,
        intent: `Use newly ready skill ${event.skill}`,
        query,
        needs: ["net:fetch"],
      },
      {
        type: "chat",
        text: `Capability ready — ran ${event.skill}.`,
      },
    ];
  }
  if (event.type === "capability.needs_secret") {
    return [
      {
        type: "chat",
        text: `${event.message} Add ${event.envKeys.join(", ")} to .env and reload.`,
      },
    ];
  }
  if (event.type === "capability.failed") {
    return [{ type: "chat", text: `Capability failed: ${event.error}` }];
  }
  if (event.type === "schedule.fired") {
    return [
      {
        type: "chat",
        text: `Schedule ${event.scheduleId} fired for ${event.goalId}.`,
      },
    ];
  }
  return [];
}

function describeEvent(event: RuntimeEvent): string {
  switch (event.type) {
    case "capability.ready":
      return `capability.ready requestId=${event.requestId} skill=${event.skill}`;
    case "capability.failed":
      return `capability.failed requestId=${event.requestId} error=${event.error}`;
    case "capability.needs_secret":
      return `capability.needs_secret requestId=${event.requestId} keys=${event.envKeys.join(",")}: ${event.message}`;
    case "secrets.provided":
      return `secrets.provided keys=${event.envKeys.join(",")}`;
    case "schedule.fired":
      return `schedule.fired scheduleId=${event.scheduleId}`;
    case "audit.flag":
      return `audit.flag auditId=${event.auditId} note=${event.note}`;
    default:
      return "event";
  }
}

/**
 * Planner: returns a list of AgentActions for the host loop.
 * Prefer emit_actions for multi-capability turns; emit_chat / emit_job remain single-action shortcuts.
 */
export async function planAgentTurn(ctx: AgentLoopContext): Promise<AgentAction[]> {
  // Resume without calling the model when we can derive the next action.
  if (!ctx.userText && ctx.event?.type === "capability.ready" && process.env.JUDGE_MODE === "1") {
    return fallbackPlanFromEvent(ctx);
  }

  let captured: AgentAction[] | null = null;

  const emitChat = defineTool({
    name: "emit_chat",
    label: "Emit Chat",
    description: "Reply with chat only (no skill work). Final action.",
    promptGuidelines: [
      "Call emit_chat, emit_job, OR emit_actions exactly once as your last action.",
    ],
    parameters: Type.Object({
      text: Type.String(),
    }),
    async execute(_id, params) {
      captured = [{ type: "chat", text: params.text }];
      return {
        content: [{ type: "text", text: params.text }],
        details: captured,
        terminate: true,
      };
    },
  });

  const emitJob = defineTool({
    name: "emit_job",
    label: "Emit Job",
    description:
      "Request skill work via run_skill (news/search/deals). Final action. Use for grow/forge when Create path is enough.",
    promptGuidelines: [
      "Call emit_chat, emit_job, OR emit_actions exactly once as your last action.",
      "Grow / forge / make an arm / extend / don't use <skill> / forums / deals / listings unlike installed skills → skill=new_snake_case not installed.",
      "Same-class news (e.g. News on OpenAI after a news skill exists) → skill=null.",
      "needs = charter capabilities only (usually [\"net:fetch\"]). Never hand_probe.",
      "query = the search string (topic), not the whole user sentence.",
      "For Doctor/async capability growth use emit_actions with request_capability + wait instead.",
    ],
    parameters: Type.Object({
      text: Type.String(),
      skill: Type.Union([Type.String(), Type.Null()]),
      intent: Type.String(),
      query: Type.String(),
      needs: Type.Array(Type.String()),
    }),
    async execute(_id, params) {
      const skill = normalizeSkill(params.skill);
      const needs = filterNeeds(params.needs);
      captured = [
        {
          type: "run_skill",
          skill,
          intent: params.intent,
          query: params.query,
          needs,
        },
        { type: "chat", text: params.text },
      ];
      return {
        content: [{ type: "text", text: params.text }],
        details: captured,
        terminate: true,
      };
    },
  });

  const briefParams = Type.Object({
    requestId: Type.String(),
    auditRef: Type.String(),
    title: Type.String(),
    intent: Type.String(),
    minimalSuccess: Type.String(),
    suggestedCaps: Type.Array(Type.String()),
    why: Type.String(),
    defaultsHint: Type.Optional(Type.String()),
    changeOf: Type.Optional(Type.String()),
  });

  const emitActions = defineTool({
    name: "emit_actions",
    label: "Emit Actions",
    description:
      "Emit one or more agent actions for this turn (request_capability, wait, run_skill, write_memory, schedule, chat). Final action.",
    promptGuidelines: [
      "Use for multi-step: several request_capability then wait; or run_skill then chat.",
      "Multiple request_capability in one turn is OK. Skills run one at a time.",
      "After requesting capabilities, include wait with those requestIds so the host parks without blocking Forge.",
      "goalId is injected by the host — do not invent filesystem paths.",
    ],
    parameters: Type.Object({
      actions: Type.Array(
        Type.Object({
          type: Type.Union([
            Type.Literal("chat"),
            Type.Literal("run_skill"),
            Type.Literal("request_capability"),
            Type.Literal("request_capability_change"),
            Type.Literal("write_memory"),
            Type.Literal("schedule"),
            Type.Literal("wait"),
          ]),
          text: Type.Optional(Type.String()),
          skill: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          intent: Type.Optional(Type.String()),
          query: Type.Optional(Type.String()),
          needs: Type.Optional(Type.Array(Type.String())),
          reason: Type.Optional(Type.String()),
          requestIds: Type.Optional(Type.Array(Type.String())),
          path: Type.Optional(Type.String()),
          markdown: Type.Optional(Type.String()),
          brief: Type.Optional(briefParams),
          changeSkill: Type.Optional(Type.String()),
          schedule: Type.Optional(
            Type.Object({
              kind: Type.Union([Type.Literal("once"), Type.Literal("cron")]),
              at: Type.Optional(Type.String()),
              expr: Type.Optional(Type.String()),
              goalId: Type.Optional(Type.String()),
              note: Type.Optional(Type.String()),
            }),
          ),
        }),
      ),
    }),
    async execute(_id, params) {
      const actions: AgentAction[] = [];
      for (const raw of params.actions) {
        switch (raw.type) {
          case "chat":
            actions.push({ type: "chat", text: raw.text ?? "" });
            break;
          case "run_skill":
            actions.push({
              type: "run_skill",
              skill: normalizeSkill(raw.skill ?? null),
              intent: raw.intent ?? "skill work",
              query: raw.query ?? "",
              needs: filterNeeds(raw.needs),
            });
            break;
          case "request_capability": {
            if (!raw.brief) break;
            actions.push({
              type: "request_capability",
              brief: briefFromParams({ ...raw.brief, goalId: ctx.goalId }),
            });
            break;
          }
          case "request_capability_change": {
            if (!raw.brief || !raw.changeSkill) break;
            actions.push({
              type: "request_capability_change",
              skill: raw.changeSkill,
              brief: briefFromParams({
                ...raw.brief,
                goalId: ctx.goalId,
                changeOf: raw.changeSkill,
              }),
            });
            break;
          }
          case "write_memory":
            actions.push({
              type: "write_memory",
              path: raw.path ?? `goals/${ctx.goalId}.md`,
              markdown: raw.markdown ?? "",
            });
            break;
          case "schedule": {
            const sched = raw.schedule;
            if (!sched) break;
            const goalId = sched.goalId || ctx.goalId;
            if (sched.kind === "once" && sched.at) {
              actions.push({
                type: "schedule",
                schedule: { kind: "once", at: sched.at, goalId, note: sched.note },
              });
            } else if (sched.kind === "cron" && sched.expr) {
              actions.push({
                type: "schedule",
                schedule: { kind: "cron", expr: sched.expr, goalId, note: sched.note },
              });
            }
            break;
          }
          case "wait":
            actions.push({
              type: "wait",
              reason: raw.reason ?? "capabilities",
              requestIds: raw.requestIds,
            });
            break;
        }
      }
      captured = actions;
      return {
        content: [{ type: "text", text: `actions:${actions.length}` }],
        details: captured,
        terminate: true,
      };
    },
  });

  const soul = existsSync(repoPath("soul.md"))
    ? readFileSync(repoPath("soul.md"), "utf8")
    : "You are Nightborn.";

  const system = [
    "You are Nightborn's Talk / agent planner.",
    "You never write skills yourself — emit actions; the host runs skills or enqueues Doctor briefs.",
    "Do not refuse growth in chat. Same-class news: skill=null. Distinct jobs / explicit grow: new snake_case skill name OR request_capability.",
    "Prefer one next action. Multiple request_capability then wait is OK. Skills are sequential.",
    "Only emit_chat, emit_job, or emit_actions. needs ⊆ charter caps (net:fetch for web).",
    soul,
    "",
    "Snapshot:",
    snapshot(),
  ].join("\n");

  const { auth, registry } = createPiAuthAndRegistry();
  const model = resolvePiModel(registry);
  const loader = createPiResourceLoader({ systemPrompt: system });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: REPO_ROOT,
    agentDir: piAgentDir(),
    authStorage: auth,
    modelRegistry: registry,
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [emitChat, emitJob, emitActions],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(REPO_ROOT),
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    session.subscribe((event) => {
      if (
        event.type === "tool_execution_end" &&
        (event.toolName === "emit_chat" ||
          event.toolName === "emit_job" ||
          event.toolName === "emit_actions")
      ) {
        const d = (event.result as { details?: AgentAction[] } | undefined)?.details;
        if (d) captured = d;
      }
    });

    const hist = history
      .slice(-10)
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n");
    const parts: string[] = [];
    parts.push(`goalId: ${ctx.goalId}`);
    if (hist) parts.push(`Recent turns:\n${hist}`);
    if (ctx.userText) parts.push(`Current user: ${ctx.userText}`);
    if (ctx.event) parts.push(`Wake event (no new user text): ${describeEvent(ctx.event)}`);
    if (ctx.observations?.length) {
      parts.push(`Observations:\n${ctx.observations.map((o) => `- ${o}`).join("\n")}`);
    }
    parts.push("Call emit_chat, emit_job, or emit_actions now.");

    await session.prompt(parts.join("\n\n"));
  } finally {
    session.dispose();
  }

  if (captured && captured.length) return captured;

  // Resume fallback when the model produced nothing
  if (ctx.event) return fallbackPlanFromEvent(ctx);

  return [{ type: "chat", text: "I heard you, but could not shape a reply." }];
}

/** Legacy single-emit Talk (fixtures / simple callers). */
export async function talkViaPi(userText: string): Promise<TalkEmit> {
  const actions = await planAgentTurn({
    goalId: `goal_talk_${Date.now().toString(36)}`,
    userText,
  });
  const chat = actions.find((a): a is Extract<AgentAction, { type: "chat" }> => a.type === "chat");
  const run = actions.find(
    (a): a is Extract<AgentAction, { type: "run_skill" }> => a.type === "run_skill",
  );
  if (run) {
    return {
      kind: "job",
      text: chat?.text ?? run.intent,
      job: {
        skill: run.skill,
        intent: run.intent,
        query: run.query,
        needs: run.needs,
      },
    };
  }
  return { kind: "chat", text: chat?.text ?? "I heard you, but could not shape a reply." };
}

export type TalkFixture = {
  match: string;
  talk: TalkEmit;
  forge?: ForgeArtifact;
};

export function loadTalkFixture(filename: string): TalkFixture | null {
  const p = repoPath("fixtures", "talk", filename);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as TalkFixture;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function findJudgeFixture(text: string): TalkFixture | null {
  if (process.env.JUDGE_MODE !== "1") return null;
  const dir = repoPath("fixtures", "talk");
  if (!existsSync(dir)) return null;
  const norm = normalize(text);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const fx = loadTalkFixture(f);
    if (fx && normalize(fx.match) === norm) return fx;
  }
  return null;
}
