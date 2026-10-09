/**
 * Cursor SDK planner backend — Agent.prompt → JSON → host types.
 * Requires CURSOR_API_KEY. Does not write skills/ or run skills; host owns install.
 */

import { Agent, CursorAgentError } from "@cursor/sdk";
import type { AgentLoopContext } from "../agent/loop.ts";
import { hostPreserveUserAskBrief, looksLikeGrowthAsk } from "../agent/loop.ts";
import type { AgentAction } from "../agent/types.ts";
import type { ForgeArtifact, ForgeContext } from "../types.ts";
import { REPO_ROOT } from "../paths.ts";
import {
  buildPlannerSystemPrompt,
  buildPlannerUserPrompt,
  coerceRawActions,
  ensureBriefsHaveUserAsk,
  fallbackPlanFromEvent,
} from "../talk.ts";
import {
  finishForgeDebug,
  forgeAuthoritativeAskPrefix,
  sessionFromCtx,
  writeForgeDebug,
} from "../forgeDebug.ts";
import { extractJsonValue, unwrapResultEnvelope } from "./parse.ts";
import type { PlannerBackend } from "./types.ts";

const FORGE_JSON_RULES = [
  "You are Nightborn's Forge.",
  "Reply with ONLY one JSON object (no markdown fences, no prose before or after).",
  "Either emit a skill OR request skill-scoped Composio access:",
  'A) Skill: name, purpose, query, capabilities, skillSource, optional composioToolkit (e.g. "apify").',
  'B) Access: { "needs_composio_access": true, "toolkit": "apify", "why": "..." } for hard scrapes/Actors (LinkedIn, etc.).',
  "skillSource HARD RULES:",
  "- No imports. No require. No export default. Use global fetch.",
  "- Read ALL of process.stdin as JSON: { query, baseUrl?, composioProxyUrl? }",
  "- Write ONE JSON object to process.stdout: { items:[{title,url,date?}] }",
  "- Composio-backed: POST {tool,arguments} to input.composioProxyUrl; never COMPOSIO_API_KEY in source.",
  "- When COMPOSIO_TOOLS / APIFY_ACTORS are listed in the prompt: use ONLY those tool slugs and actorIds — never invent APIFY_* or owner~actor names.",
  "- process.env.BRAVE_API_KEY (or TAVILY_API_KEY). AbortSignal.timeout(6000).",
  "- NEVER string literals starting with / — use String.fromCharCode(47) for path joins.",
  "- NEVER put / inside a regex literal (JSON escaping yields SyntaxError: Invalid regular expression flags). Prefer String.includes / indexOf, or new RegExp(\"marketplace|item\").",
  "- Forums/deals → Brave web search; company news → news search; LinkedIn/Actors → needs_composio_access apify.",
  "- listings.http_scrape: site:<siteHost> search; drop shopping-index hubs; retry year+make until vehicle cards remain.",
  "- NEVER dial Bland / run the skill. notify:phone skills must dry-run when NIGHTBORN_BLOCK_OUTBOUND=1 (no fetch to api.bland.ai).",
  "Do NOT write files under skills/. Do NOT run shell installs. JSON only.",
].join("\n");

const PLAN_JSON_RULES = [
  "Reply with ONLY one JSON object (no markdown fences, no prose).",
  'Either {"kind":"chat","text":"..."} OR {"kind":"actions","actions":[...]}',
  "Action types: chat, run_skill, request_capability, request_capability_change, write_memory, schedule, wait.",
  "Missing skill / new site scraper / LinkedIn scraper → request_capability (defaultsHint when known) then wait with those requestIds.",
  "Forge may request skill-scoped Composio while building — Talk does not request_access for growth. Never email/SMTP via Composio.",
  "run_skill: installed snake_case name only, or skill=null for same-class Reuse. Never Create via run_skill.",
  "Do NOT edit the repo, write skills/, or run shell commands. JSON only — the host executes actions.",
].join("\n");

function cursorModelId(): string {
  return (process.env.PLANNER_CURSOR_MODEL || "composer-2.5").trim() || "composer-2.5";
}

function requireApiKey(): string {
  const key = (process.env.CURSOR_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "planner_cursor: CURSOR_API_KEY required when PLANNER=cursor (Dashboard → Integrations)",
    );
  }
  return key;
}

async function promptCursor(prompt: string): Promise<string> {
  const apiKey = requireApiKey();
  try {
    const result = await Agent.prompt(prompt, {
      apiKey,
      model: { id: cursorModelId() },
      local: { cwd: REPO_ROOT },
    });
    if (result.status === "error") {
      throw new Error(`planner_cursor: run failed (${result.id ?? "?"})`);
    }
    const text =
      typeof result.result === "string"
        ? result.result
        : result.result != null
          ? JSON.stringify(result.result)
          : "";
    if (!text.trim()) throw new Error("planner_cursor: empty result");
    return text;
  } catch (err) {
    if (err instanceof CursorAgentError) {
      throw new Error(
        `planner_cursor: startup failed (${err.message}; retryable=${err.isRetryable})`,
      );
    }
    throw err;
  }
}

function asAccessRequest(o: unknown): { toolkit: string; why: string } | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.needs_composio_access !== true) return null;
  const toolkit = typeof r.toolkit === "string" ? r.toolkit.trim() : "";
  if (!toolkit) return null;
  return {
    toolkit,
    why: typeof r.why === "string" ? r.why : "Forge needs Composio access",
  };
}

function asArtifact(o: unknown): ForgeArtifact | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.skillSource !== "string" || !r.skillSource.trim()) return null;
  const caps = Array.isArray(r.capabilities)
    ? r.capabilities.filter((c): c is string => typeof c === "string")
    : ["net:fetch"];
  const name =
    typeof r.name === "string" && r.name.trim() ? r.name.trim() : "forged_skill";
  const toolkit =
    typeof r.composioToolkit === "string" ? r.composioToolkit.trim().toLowerCase() : "";
  return {
    name,
    purpose: typeof r.purpose === "string" ? r.purpose : "",
    query: typeof r.query === "string" ? r.query : "",
    capabilities: caps.length ? caps : ["net:fetch"],
    skillSource: r.skillSource,
    ...(toolkit
      ? { composio: { toolkit, userId: `nightborn:skill:${name}` } }
      : {}),
  };
}

function parsePlanJson(text: string, goalId: string): AgentAction[] | null {
  let root: unknown;
  try {
    root = unwrapResultEnvelope(extractJsonValue(text));
  } catch {
    return null;
  }
  if (!root || typeof root !== "object") return null;
  const o = root as Record<string, unknown>;

  if (o.kind === "chat" && typeof o.text === "string") {
    return [{ type: "chat", text: o.text }];
  }

  if (o.kind === "actions" && Array.isArray(o.actions)) {
    const actions = coerceRawActions(o.actions, goalId);
    return actions.length ? actions : null;
  }

  // Bare array of actions
  if (Array.isArray(root)) {
    const actions = coerceRawActions(root, goalId);
    return actions.length ? actions : null;
  }

  // Bare { actions: [...] } without kind
  if (Array.isArray(o.actions)) {
    const actions = coerceRawActions(o.actions, goalId);
    return actions.length ? actions : null;
  }

  // Bare chat text field
  if (typeof o.text === "string" && !o.type) {
    return [{ type: "chat", text: o.text }];
  }

  return null;
}

export async function planTurnViaCursorSdk(
  ctx: AgentLoopContext,
): Promise<AgentAction[]> {
  const prompt = [
    buildPlannerSystemPrompt(),
    "",
    PLAN_JSON_RULES,
    "",
    buildPlannerUserPrompt(ctx, "Emit the JSON object now."),
  ].join("\n");

  try {
    const text = await promptCursor(prompt);
    const actions = parsePlanJson(text, ctx.goalId);
    if (actions?.length) {
      return ensureBriefsHaveUserAsk(actions, ctx.userText);
    }
  } catch {
    /* fall through to host heuristics */
  }

  if (ctx.event) return fallbackPlanFromEvent(ctx);
  if (ctx.userText && looksLikeGrowthAsk(ctx.userText)) {
    const preserved = hostPreserveUserAskBrief(ctx.userText, ctx.goalId);
    if (preserved.length) return preserved;
  }
  return [{ type: "chat", text: "I heard you, but could not shape a reply." }];
}

export async function forgeSkillViaCursorSdk(
  intent: string,
  query: string,
  proposedName?: string | null,
  ctx?: ForgeContext | null,
): Promise<ForgeArtifact> {
  const hint = proposedName ? `\nproposedName=${JSON.stringify(proposedName)}` : "";
  const scope = ctx
    ? [
        `\nskillName=${JSON.stringify(ctx.skillName)}`,
        `\nrequestId=${JSON.stringify(ctx.requestId)}`,
        ctx.defaultsHint != null ? `\ndefaultsHint=${JSON.stringify(ctx.defaultsHint)}` : "",
        ctx.siteHost != null ? `\nsiteHost=${JSON.stringify(ctx.siteHost)}` : "",
        ctx.minimalSuccess != null
          ? `\nminimalSuccess=${JSON.stringify(ctx.minimalSuccess)}`
          : "",
      ].join("")
    : "";
  const prompt =
    `${FORGE_JSON_RULES}\n` +
    `${forgeAuthoritativeAskPrefix(ctx)}` +
    `intent=${JSON.stringify(intent)}\n` +
    `query=${JSON.stringify(query)}${hint}${scope}\n` +
    `Emit the JSON object now.`;

  const dbg = sessionFromCtx(ctx ?? undefined, "cursor-sdk");
  let debugFinished = false;
  const doneDebug = (opts?: { promptBytes?: number; stdoutBytes?: number; error?: string }) => {
    if (debugFinished) return;
    debugFinished = true;
    finishForgeDebug(dbg, opts);
  };
  writeForgeDebug(dbg, "prompt.txt", prompt);

  let text = "";
  try {
    text = await promptCursor(prompt);
    writeForgeDebug(dbg, "stdout.txt", text);

    let root: unknown;
    try {
      root = unwrapResultEnvelope(extractJsonValue(text));
    } catch (err) {
      const msg = `forge_invalid: cursor SDK JSON (${err instanceof Error ? err.message : String(err)})`;
      doneDebug({ promptBytes: prompt.length, stdoutBytes: text.length, error: msg });
      throw new Error(msg);
    }

    const {
      NeedsComposioAccessError,
      NeedsSkillAfterComposioError,
      ensureRunnableSkillSource,
      sanitizeSkillSource,
    } = await import("../forge.ts");
    const { requestToolkitAccess, skillComposioUserId } = await import("../composio.ts");

    let rootParsed: unknown = root;
    const access = asAccessRequest(rootParsed);
    let connectedToolkit: string | null = null;

    if (access) {
      writeForgeDebug(dbg, "result.json", access);
      const skillName =
        proposedName?.trim() || ctx?.skillName?.trim() || "forged_skill";
      const requestId = ctx?.requestId?.trim() || `forge_${skillName}`;
      const goalId = ctx?.goalId?.trim() || "goal_forge";
      const result = await requestToolkitAccess({
        toolkit: access.toolkit,
        requestId,
        goalId,
        skillName,
        why: access.why,
      });
      if (!result.ok) {
        const msg = `forge_invalid: composio access ${result.code}: ${result.message}`;
        doneDebug({ promptBytes: prompt.length, stdoutBytes: text.length, error: msg });
        throw new Error(msg);
      }
      if (!result.alreadyConnected) {
        doneDebug({ promptBytes: prompt.length, stdoutBytes: text.length });
        throw new NeedsComposioAccessError({
          toolkit: result.toolkit,
          requestId: result.requestId,
          skillName,
          redirectUrl: result.redirectUrl,
          why: access.why,
        });
      }
      connectedToolkit = result.toolkit;
    }

    let art = asArtifact(rootParsed);

    if (!art && connectedToolkit) {
      const skillName =
        proposedName?.trim() || ctx?.skillName?.trim() || "forged_skill";
      const askForCatalog = (ctx?.userAsk?.trim() || intent || query).trim();
      let catalog = "";
      try {
        const { buildForgeComposioCatalog } = await import("../forgeComposioCatalog.ts");
        catalog = await buildForgeComposioCatalog(skillName, askForCatalog);
      } catch (err) {
        catalog = `COMPOSIO_TOOLS:\n(catalog build failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      const skillPrompt =
        `${FORGE_JSON_RULES}\n` +
        `${forgeAuthoritativeAskPrefix(ctx)}` +
        `Composio toolkit ${JSON.stringify(connectedToolkit)} is ALREADY connected for skill ${JSON.stringify(skillName)}.\n` +
        `Do NOT return needs_composio_access again.\n` +
        `Return skill JSON with skillSource + composioToolkit=${JSON.stringify(connectedToolkit)}.\n` +
        (catalog.trim() ? `\n${catalog.trim()}\n` : "") +
        `intent=${JSON.stringify(intent)}\n` +
        `query=${JSON.stringify(query)}\n` +
        `userAsk=${JSON.stringify(askForCatalog)}\n` +
        `proposedName=${JSON.stringify(skillName)}\n` +
        `Emit the skill JSON object now.`;
      writeForgeDebug(dbg, "prompt_reprompt.txt", skillPrompt);
      let repText = "";
      try {
        repText = await promptCursor(skillPrompt);
        writeForgeDebug(dbg, "stdout_reprompt.txt", repText);
        rootParsed = unwrapResultEnvelope(extractJsonValue(repText));
        art = asArtifact(rootParsed);
        text = repText;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        doneDebug({
          promptBytes: prompt.length + skillPrompt.length,
          stdoutBytes: repText.length || text.length,
          error: detail,
        });
        throw new NeedsSkillAfterComposioError({
          toolkit: connectedToolkit,
          skillName,
          detail,
        });
      }
      if (!art) {
        doneDebug({
          promptBytes: prompt.length + skillPrompt.length,
          stdoutBytes: text.length,
          error: "needs_skill_after_composio: no skillSource after re-prompt",
        });
        throw new NeedsSkillAfterComposioError({
          toolkit: connectedToolkit,
          skillName,
          detail: "no skillSource after re-prompt",
        });
      }
      if (!art.composio) {
        art = {
          ...art,
          name: proposedName?.trim() || art.name,
          composio: {
            toolkit: connectedToolkit,
            userId: skillComposioUserId(proposedName?.trim() || art.name),
          },
        };
      }
    }

    if (!art) {
      const msg = "forge_invalid: no skillSource in cursor SDK result";
      doneDebug({ promptBytes: prompt.length, stdoutBytes: text.length, error: msg });
      throw new Error(msg);
    }
    if (proposedName) art = { ...art, name: proposedName };
    if (!art.query) art = { ...art, query };

    art = {
      ...art,
      skillSource: sanitizeSkillSource(art.skillSource!),
    };
    let out = ensureRunnableSkillSource(art, intent);

    const { smokeTestForgeArtifact } = await import("../forgeSmokeTest.ts");
    const { buildForgeComposioCatalog } = await import("../forgeComposioCatalog.ts");
    const skillNameForSmoke =
      proposedName?.trim() || ctx?.skillName?.trim() || out.name || "forged_skill";
    const testQuery = ctx?.userAsk?.trim() || out.query?.trim() || query;
    let smoke = await smokeTestForgeArtifact({
      artifact: out,
      skillName: skillNameForSmoke,
      testQuery,
      defaultsHint: ctx?.defaultsHint,
    });
    writeForgeDebug(dbg, "smoke1.txt", smoke.detail);

    if (!smoke.ok && (out.composio || connectedToolkit)) {
      const toolkit = out.composio?.toolkit || connectedToolkit || "apify";
      const askForCatalog = (ctx?.userAsk?.trim() || intent || query).trim();
      let catalog = "";
      try {
        catalog = await buildForgeComposioCatalog(skillNameForSmoke, askForCatalog);
      } catch (err) {
        catalog = `COMPOSIO_TOOLS:\n(catalog build failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      const runSmokeFix = async (smokeError: string, tag: string) => {
        const fixPrompt =
          `${FORGE_JSON_RULES}\n` +
          `${forgeAuthoritativeAskPrefix(ctx)}` +
          `Composio toolkit ${JSON.stringify(toolkit)} is connected for skill ${JSON.stringify(skillNameForSmoke)}.\n` +
          `The previous skillSource FAILED the host smoke test. Fix it and emit skill JSON again.\n` +
          `SMOKE_ERROR=${JSON.stringify(smokeError.slice(0, 900))}\n` +
          `Prefer COMPOSIO_TOOLS sync dataset tools (e.g. APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS) over async APIFY_RUN_ACTOR when listed.\n` +
          `If SMOKE_ERROR mentions a required input field (e.g. startUrls), EVERY APIFY_RUN_ACTOR for that actor MUST include it — read ACTOR_INPUT_HINTS.\n` +
          `If SMOKE_ERROR is SyntaxError / Invalid regular expression flags: remove / from regex literals; use includes() or new RegExp without slash delimiters.\n` +
          `Parse Composio proxy JSON carefully. actorId only from APIFY_ACTORS.\n` +
          `Do NOT return needs_composio_access. Do NOT invent tool slugs or actorIds.\n` +
          (catalog.trim() ? `\n${catalog.trim()}\n` : "") +
          `intent=${JSON.stringify(intent)}\n` +
          `query=${JSON.stringify(query)}\n` +
          `userAsk=${JSON.stringify(askForCatalog)}\n` +
          `proposedName=${JSON.stringify(skillNameForSmoke)}\n` +
          `Emit the fixed skill JSON object now.`;
        writeForgeDebug(dbg, `prompt_${tag}.txt`, fixPrompt);
        const fixText = await promptCursor(fixPrompt);
        writeForgeDebug(dbg, `stdout_${tag}.txt`, fixText);
        const fixRoot = unwrapResultEnvelope(extractJsonValue(fixText));
        let fixed = asArtifact(fixRoot);
        if (!fixed) return fixText;
        if (!fixed.composio) {
          fixed = {
            ...fixed,
            name: proposedName?.trim() || fixed.name,
            composio: {
              toolkit,
              userId: skillComposioUserId(proposedName?.trim() || fixed.name),
            },
          };
        }
        if (proposedName) fixed = { ...fixed, name: proposedName };
        if (!fixed.query) fixed = { ...fixed, query };
        fixed = {
          ...fixed,
          skillSource: sanitizeSkillSource(fixed.skillSource!),
        };
        out = ensureRunnableSkillSource(fixed, intent);
        smoke = await smokeTestForgeArtifact({
          artifact: out,
          skillName: skillNameForSmoke,
          testQuery,
          defaultsHint: ctx?.defaultsHint,
        });
        writeForgeDebug(dbg, tag === "smoke_fix" ? "smoke2.txt" : "smoke3.txt", smoke.detail);
        return fixText;
      };
      try {
        text = await runSmokeFix(smoke.detail, "smoke_fix");
        if (
          !smoke.ok &&
          /SyntaxError|Invalid regular expression/i.test(smoke.detail)
        ) {
          text = await runSmokeFix(smoke.detail, "smoke_syntax_fix");
        }
      } catch (err) {
        writeForgeDebug(
          dbg,
          "smoke_fix_error.txt",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (!smoke.ok) {
      const msg = `forge_invalid: smoke test failed · ${smoke.detail}`;
      doneDebug({ promptBytes: prompt.length, stdoutBytes: text.length, error: msg });
      if (out.composio || connectedToolkit) {
        throw new NeedsSkillAfterComposioError({
          toolkit: out.composio?.toolkit || connectedToolkit || "apify",
          skillName: skillNameForSmoke,
          detail: smoke.detail,
        });
      }
      throw new Error(msg);
    }

    writeForgeDebug(dbg, "result.json", {
      name: out.name,
      purpose: out.purpose,
      query: out.query,
      capabilities: out.capabilities,
      skillSourceLen: out.skillSource?.length ?? 0,
      composio: out.composio ?? null,
      smoke: smoke.detail,
    });
    doneDebug({ promptBytes: prompt.length, stdoutBytes: text.length });
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    doneDebug({
      promptBytes: prompt.length,
      stdoutBytes: text.length,
      error:
        code === "needs_composio_access" || code === "needs_skill_after_composio"
          ? undefined
          : msg,
    });
    throw err;
  }
}

export const cursorPlanner: PlannerBackend = {
  planTurn: planTurnViaCursorSdk,
  forgeSkill: forgeSkillViaCursorSdk,
};
