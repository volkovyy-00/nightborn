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

/** Replace Pi history window from the goal transcript (source of truth). */
export function syncTalkHistoryFromTranscript(
  turns: { role: "user" | "assistant"; text: string }[],
): void {
  history.length = 0;
  for (const t of turns.slice(-10)) history.push(t);
}

function snapshot(): string {
  const names = listSkillDirs(dataPath("skills")).filter((n) => n !== "hand_probe");
  return [
    `Capabilities (needs may only use these): ${ALLOWED_CAPS.join(", ")}`,
    `Installed skills: ${names.length ? names.join(", ") : "(none)"}`,
    "run_skill: ONLY installed skill names, or skill=null for Reuse-by-capability (http template).",
    "Missing capability / new hand: request_capability (+ defaultsHint) then wait — Doctor forges/installs. Talk never Create.",
    "Every request_capability brief MUST set userAsk to the exact current user message (verbatim).",
    "Listings/deals: explore with an installed search skill if any; else request scrapers for the surfaces the user named, then wait — do not invent cars.com.",
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
  userAsk?: string;
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
  if (params.userAsk?.trim()) brief.userAsk = params.userAsk.trim();
  return brief;
}

/** Fill missing brief.userAsk from the current user turn (host safety net). */
export function ensureBriefsHaveUserAsk(
  actions: AgentAction[],
  userText?: string,
): AgentAction[] {
  const ask = userText?.trim();
  if (!ask) return actions;
  return actions.map((a) => {
    if (
      (a.type === "request_capability" || a.type === "request_capability_change") &&
      !a.brief.userAsk?.trim()
    ) {
      return { ...a, brief: { ...a.brief, userAsk: ask } };
    }
    return a;
  });
}

/**
 * Heuristic plan on resume (and when the model returns nothing).
 * capability.ready → run the installed skill with the persisted goal query.
 */
export function fallbackPlanFromEvent(
  ctx: AgentLoopContext,
): AgentAction[] {
  const event = ctx.event;
  if (!event) return [];
  if (event.type === "capability.ready") {
    const query =
      ctx.observations?.find((o) => o.startsWith("query:"))?.slice("query:".length).trim() ||
      "used cars under 10000";
    // Run the ready skill only — host synthesizes ranked deals when allSatisfied.
    return [
      {
        type: "run_skill",
        skill: event.skill,
        intent: `Use newly ready skill ${event.skill}`,
        query,
        needs: ["net:fetch"],
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
  if (event.type === "access.needs_connect") {
    return [
      {
        type: "chat",
        text: event.redirectUrl
          ? `${event.message}\nOpen this Connect Link, finish auth, then I will continue: ${event.redirectUrl}`
          : event.message,
      },
    ];
  }
  if (event.type === "access.ready") {
    return [
      {
        type: "chat",
        text: `Connected ${event.toolkit} via Composio — Doctor is forging the skill with that access.`,
      },
    ];
  }
  if (event.type === "access.failed") {
    return [
      {
        type: "chat",
        text: `Composio access failed for ${event.toolkit}: ${event.error}`,
      },
    ];
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
      return `capability.needs_secret requestId=${event.requestId} goalId=${event.goalId} keys=${event.envKeys.join(",")}: ${event.message}`;
    case "access.needs_connect":
      return `access.needs_connect requestId=${event.requestId} toolkit=${event.toolkit} url=${event.redirectUrl}`;
    case "access.ready":
      return `access.ready requestId=${event.requestId} toolkit=${event.toolkit}`;
    case "access.failed":
      return `access.failed requestId=${event.requestId} toolkit=${event.toolkit} error=${event.error}`;
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

type RawAction = {
  type: string;
  text?: string;
  skill?: string | null;
  intent?: string;
  query?: string;
  needs?: string[];
  reason?: string;
  requestIds?: string[];
  path?: string;
  markdown?: string;
  brief?: {
    requestId: string;
    auditRef: string;
    title: string;
    intent: string;
    minimalSuccess: string;
    suggestedCaps: string[];
    why: string;
    defaultsHint?: string;
    changeOf?: string;
    userAsk?: string;
  };
  changeSkill?: string;
  toolkit?: string;
  requestId?: string;
  why?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  schedule?: {
    kind: "once" | "cron";
    at?: string;
    expr?: string;
    goalId?: string;
    note?: string;
  };
};

/** Coerce model/JSON action records into host AgentAction[] (shared by Pi + Cursor). */
export function coerceRawActions(rawActions: unknown[], goalId: string): AgentAction[] {
  const actions: AgentAction[] = [];
  for (const item of rawActions) {
    if (!item || typeof item !== "object") continue;
    const raw = item as RawAction;
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
          brief: briefFromParams({ ...raw.brief, goalId }),
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
            goalId,
            changeOf: raw.changeSkill,
          }),
        });
        break;
      }
      case "request_access": {
        const toolkit = (raw.toolkit ?? "").trim();
        if (!toolkit) break;
        const requestId =
          (raw.requestId ?? "").trim() ||
          `acc_${toolkit}_${Date.now().toString(36)}`;
        actions.push({
          type: "request_access",
          toolkit,
          requestId,
          why: raw.why ?? `Need Composio access to ${toolkit}`,
        });
        break;
      }
      case "run_composio_tool": {
        const tool = (raw.tool ?? "").trim();
        if (!tool) break;
        actions.push({
          type: "run_composio_tool",
          tool,
          arguments:
            raw.arguments && typeof raw.arguments === "object"
              ? (raw.arguments as Record<string, unknown>)
              : {},
          intent: raw.intent ?? `Run Composio tool ${tool}`,
        });
        break;
      }
      case "write_memory":
        actions.push({
          type: "write_memory",
          path: raw.path ?? `goals/${goalId}.md`,
          markdown: raw.markdown ?? "",
        });
        break;
      case "schedule": {
        const sched = raw.schedule;
        if (!sched) break;
        const schedGoalId = sched.goalId || goalId;
        if (sched.kind === "once" && sched.at) {
          actions.push({
            type: "schedule",
            schedule: { kind: "once", at: sched.at, goalId: schedGoalId, note: sched.note },
          });
        } else if (sched.kind === "cron" && sched.expr) {
          actions.push({
            type: "schedule",
            schedule: { kind: "cron", expr: sched.expr, goalId: schedGoalId, note: sched.note },
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
  return actions;
}

/** Soul + charter snapshot for planner prompts (Pi tools or Cursor JSON). */
export function buildPlannerSystemPrompt(): string {
  const soul = existsSync(repoPath("soul.md"))
    ? readFileSync(repoPath("soul.md"), "utf8")
    : "You are Nightborn.";
  return [
    "You are Nightborn's Talk / agent planner.",
    "You never write or install skills — emit actions; Doctor forges new hands; the host Reuses installed ones.",
    "Growth: request_capability + wait. Forge may request skill-scoped Composio (Apify) while building; Talk does not own marketplace access.",
    "Every request_capability must set userAsk to the exact Current user message (verbatim). Intent/title may name a surface; userAsk stays verbatim.",
    "Do not invent cars.com or remap Marketplace → Cars.com — Forge follows userAsk.",
    "run_skill never Creates (missing name → host routes to Doctor anyway). Never request email/SMTP via Composio.",
    "Same-class news: run_skill skill=null. Prefer one next action; multiple request_capability then wait is OK.",
    "needs ⊆ charter caps (net:fetch for web; notify:phone for calls).",
    soul,
    "",
    "Snapshot:",
    snapshot(),
  ].join("\n");
}

/** User/event prompt body shared by planner backends. */
export function buildPlannerUserPrompt(ctx: AgentLoopContext, closer: string): string {
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
  parts.push(closer);
  return parts.join("\n\n");
}

/**
 * Planner: returns a list of AgentActions for the host loop.
 * Backend selected by PLANNER=pi|cursor (default pi).
 */
export async function planAgentTurn(ctx: AgentLoopContext): Promise<AgentAction[]> {
  // Event wakes (ready / failed / needs_secret / schedule): deterministic, no model.
  if (!ctx.userText && ctx.event) {
    return fallbackPlanFromEvent(ctx);
  }
  const { getPlanner } = await import("./planner/index.ts");
  return getPlanner().planTurn(ctx);
}

/**
 * Pi tool-calling planner (emit_chat / emit_actions).
 * Growth is Doctor-only (`request_capability` + `wait`). `run_skill` is Reuse-only.
 */
export async function planAgentTurnViaPi(ctx: AgentLoopContext): Promise<AgentAction[]> {
  let captured: AgentAction[] | null = null;

  const emitChat = defineTool({
    name: "emit_chat",
    label: "Emit Chat",
    description: "Reply with chat only (no skill work). Final action.",
    promptGuidelines: [
      "Call emit_chat OR emit_actions exactly once as your last action.",
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

  const briefParams = Type.Object({
    requestId: Type.String(),
    auditRef: Type.String(),
    title: Type.String(),
    intent: Type.String(),
    minimalSuccess: Type.String(),
    suggestedCaps: Type.Array(Type.String()),
    why: Type.String(),
    userAsk: Type.Optional(Type.String()),
    defaultsHint: Type.Optional(Type.String()),
    changeOf: Type.Optional(Type.String()),
  });

  const emitActions = defineTool({
    name: "emit_actions",
    label: "Emit Actions",
    description:
      "Emit agent actions: request_capability + wait to grow hands; request_access for Composio marketplace; run_skill / run_composio_tool; chat/memory/schedule. Final action.",
    promptGuidelines: [
      "Missing skill / new site scraper / new call hand → request_capability (with defaultsHint) then wait. Never grow via run_skill Create.",
      "Hard scrapes / Actors (LinkedIn, etc.): still request_capability (+ wait). Forge may request skill-scoped Composio access; you do not call request_access for growth.",
      "run_skill: installed snake_case name, or skill=null for same-class Reuse (news/http). needs ⊆ charter.",
      "Multiple request_capability in one turn is OK; then wait with those SAME requestIds (never wait with an empty requestIds array).",
      "Listings/deals: request capability for surfaces the user named (or search.web to explore); never invent cars.com.",
      "Each request_capability brief needs requestId, auditRef, title, intent, minimalSuccess, suggestedCaps, why, userAsk (exact current user message); defaultsHint when known.",
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
            Type.Literal("request_access"),
            Type.Literal("run_composio_tool"),
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
          toolkit: Type.Optional(Type.String()),
          requestId: Type.Optional(Type.String()),
          why: Type.Optional(Type.String()),
          tool: Type.Optional(Type.String()),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
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
      const actions = ensureBriefsHaveUserAsk(
        coerceRawActions(params.actions as unknown[], ctx.goalId),
        ctx.userText,
      );
      captured = actions;
      return {
        content: [{ type: "text", text: `actions:${actions.length}` }],
        details: captured,
        terminate: true,
      };
    },
  });

  const system = [
    buildPlannerSystemPrompt(),
    "Only emit_chat or emit_actions.",
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
    customTools: [emitChat, emitActions],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(REPO_ROOT),
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    session.subscribe((event) => {
      if (
        event.type === "tool_execution_end" &&
        (event.toolName === "emit_chat" || event.toolName === "emit_actions")
      ) {
        const d = (event.result as { details?: AgentAction[] } | undefined)?.details;
        if (d) captured = d;
      }
    });

    await session.prompt(
      buildPlannerUserPrompt(ctx, "Call emit_chat or emit_actions now."),
    );
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
