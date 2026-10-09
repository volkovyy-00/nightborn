import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DecisionJson, Job, TalkResult } from "./types.ts";
import { getCharterHash } from "./charter.ts";
import { appendLog } from "./log.ts";
import { dataPath } from "./paths.ts";
import { listSkillDirs } from "./hash.ts";
import { tripwireMatch } from "./tripwire.ts";
import { replyFor } from "./replies.ts";
import {
  checkReuseHashes,
  denyAndWipe,
  installSkill,
  wardenFinal,
  wardenPre,
  wipeStaging,
} from "./warden.ts";
import {
  copyEmailSendTemplate,
  defaultNewsSkillSource,
  ensureRunnableSkillSource,
  forgeSkill,
  loadForgeFixture,
  writeForgedSkill,
} from "./forge.ts";
import {
  findJudgeFixture,
  loadTalkFixture,
  planAgentTurn,
  syncTalkHistoryFromTranscript,
  talkEmitToActions,
  type TalkFixture,
} from "./talk.ts";
import type { ForgeArtifact } from "./types.ts";
import { runSkill } from "./exec.ts";
import { validateHttpOutput } from "../templates/schemas.ts";
import {
  clearProvisionalGrant,
  grantKeysForCaps,
  provisionalOr,
  runWithOutboundBlocked,
  runWithProvisionalScope,
} from "./broker.ts";
import { acquireOutboundCall } from "./callGate.ts";
import {
  newGoalId,
  runAgentLoop,
  wireAgentResume,
  type AgentLoopResult,
} from "./agent/loop.ts";
import { append as auditAppend } from "./audit.ts";
import type { ResumeContext } from "./agent/resume.ts";
import {
  appendMessage,
  recentForTalk,
  rehydrateTranscript,
} from "./transcript.ts";
import {
  appendListingBatch,
  isListingHub,
  parseListingStdout,
} from "./listings.ts";

function syncHistory(): void {
  syncTalkHistoryFromTranscript(recentForTalk(10));
}

function talkText(talk: TalkResult): string {
  return talk.kind === "chat" ? talk.text : talk.reply;
}

function skillsRoot(): string {
  return dataPath("skills");
}

type NewsItem = { title?: string; url?: string; date?: string };

/** Format skill stdout into a short analyst reply (install / reuse). */
function formatNewsReply(prefix: string, stdout: string): string {
  let items: NewsItem[] = [];
  try {
    const data = JSON.parse(stdout) as { items?: NewsItem[] };
    items = Array.isArray(data.items) ? data.items : [];
  } catch {
    return prefix;
  }
  const usable = items.filter(
    (it) => !isListingHub(it.title || "", it.url || ""),
  );
  if (!usable.length) {
    return (
      `${prefix}\n\n` +
      `No vehicle detail cards in this batch (${items.length} hits looked like shopping-index hubs).`
    );
  }
  const lines = usable.slice(0, 5).map((it, i) => {
    const title = (it.title || "(untitled)").trim();
    const url = (it.url || "").trim();
    const date = it.date ? ` (${it.date})` : "";
    return `${i + 1}. ${title}${date}${url ? `\n   ${url}` : ""}`;
  });
  return `${prefix}\n\n${lines.join("\n")}`;
}

function loadDecision(skillName: string): DecisionJson | null {
  const p = path.join(skillsRoot(), skillName, "decision.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as DecisionJson;
}

/** Runner rule §9 — returns reuse skill name or create with gap detail. */
function chooseReuse(job: Job): { mode: "reuse"; skill: string; detail: string } | { mode: "create"; detail: string } {
  if (job.skill) {
    const d = loadDecision(job.skill);
    if (d) return { mode: "reuse", skill: job.skill, detail: "by name" };
    // Non-null skill not installed → Create (explicit grow); skip capability match
    return { mode: "create", detail: "named skill missing → create" };
  }
  const needs = job.needs.length ? job.needs : ["net:fetch"];
  const matches: string[] = [];
  for (const name of listSkillDirs(skillsRoot())) {
    const d = loadDecision(name);
    if (!d) continue;
    if (d.template !== "http") continue;
    if (needs.every((n) => d.capabilities.includes(n))) matches.push(name);
  }
  if (matches.length === 1) return { mode: "reuse", skill: matches[0], detail: "by capability" };
  if (matches.length >= 2) {
    return { mode: "create", detail: "ambiguous capability match → create" };
  }
  return { mode: "create", detail: "no installed skill covers <intent> → create" };
}

function offlineBaseUrl(capsOrNeeds?: string[]): string | undefined {
  if (process.env.OFFLINE !== "1") return undefined;
  const port = process.env.PORT ?? "8787";
  const provider =
    capsOrNeeds?.includes("notify:phone")
      ? "bland"
      : (process.env.SEARCH_PROVIDER ?? "brave").toLowerCase();
  return `http://127.0.0.1:${port}/mock/${provider}`;
}

async function runReuse(
  skillName: string,
  job: Job,
  source?: "live" | "fixture",
  matchDetail = "by name",
  goalId?: string,
): Promise<TalkResult> {
  const dir = path.join(skillsRoot(), skillName);
  const decision = loadDecision(skillName);
  if (!decision) {
    return {
      kind: "job",
      job,
      outcome: "broken",
      skill: skillName,
      failureCode: "forge_invalid",
      reply: replyFor("forge_invalid", "Missing decision."),
    };
  }
  const mismatch = checkReuseHashes(dir, decision);
  if (mismatch) {
    appendLog({
      actor: "runner",
      event: "broken",
      skill: skillName,
      decision: "fail",
      failureCode: mismatch,
      charterHash: getCharterHash(),
      voice: "voice/broken.wav",
      detail: mismatch,
      source,
    });
    return {
      kind: "job",
      job,
      outcome: "broken",
      skill: skillName,
      failureCode: mismatch,
      reply: replyFor(mismatch, "Hash check failed."),
    };
  }

  appendLog({
    actor: "runner",
    event: "matched",
    skill: skillName,
    decision: "allow",
    charterHash: getCharterHash(),
    detail: matchDetail,
    source,
  });

  const isCall = decision.capabilities.includes("notify:phone");
  let query = job.query;
  let releaseCall: (() => void) | undefined;
  if (isCall) {
    const gate = acquireOutboundCall(job.query);
    if (!gate.ok) {
      appendLog({
        actor: "runner",
        event: "broken",
        skill: skillName,
        decision: "fail",
        charterHash: getCharterHash(),
        voice: "voice/broken.wav",
        detail: gate.reason,
        source,
      });
      return {
        kind: "job",
        job,
        outcome: "broken",
        skill: skillName,
        reply: gate.reason,
      };
    }
    query = gate.query;
    releaseCall = gate.release;
    appendLog({
      actor: "runner",
      event: "matched",
      skill: skillName,
      decision: "allow",
      charterHash: getCharterHash(),
      detail: gate.redirected
        ? `call gate · redirected ${gate.requestedPhone || "(empty)"} → ${gate.allowedPhone}`
        : `call gate · dialing ${gate.allowedPhone}`,
      source,
    });
  }

  const input: {
    query: string;
    baseUrl?: string;
    composioProxyUrl?: string;
  } = { query };
  const base = offlineBaseUrl(decision.capabilities);
  if (base) input.baseUrl = base;
  if (decision.composio) {
    const { composioProxyUrlForSkill } = await import("./composio.ts");
    input.composioProxyUrl = composioProxyUrlForSkill(skillName);
  }

  const envKeys = isCall
    ? [...new Set([...decision.env, ...grantKeysForCaps(decision.capabilities)])]
    : decision.env;

  if (source === "live" && goalId) {
    appendMessage({
      goalId,
      role: "status",
      skill: skillName,
      text: `Running ${skillName}…`,
    });
  }

  try {
    const result = await runSkill(path.join(dir, "skill.mjs"), dir, input, envKeys, 15_000);
    if (result.timedOut) {
      appendLog({
        actor: "test",
        event: "broken",
        skill: skillName,
        decision: "fail",
        failureCode: "timeout",
        charterHash: getCharterHash(),
        voice: "voice/broken.wav",
        source,
      });
      return {
        kind: "job",
        job,
        outcome: "broken",
        skill: skillName,
        failureCode: "timeout",
        reply: replyFor("timeout", "Timed out."),
      };
    }
    if (!result.ok) {
      appendLog({
        actor: "test",
        event: "broken",
        skill: skillName,
        decision: "fail",
        failureCode: "test_exit_nonzero",
        charterHash: getCharterHash(),
        voice: "voice/broken.wav",
        source,
      });
      return {
        kind: "job",
        job,
        outcome: "broken",
        skill: skillName,
        failureCode: "test_exit_nonzero",
        reply: replyFor("test_exit_nonzero", "Run failed."),
      };
    }

    appendLog({
      actor: "runner",
      event: "reuse",
      skill: skillName,
      decision: "allow",
      charterHash: getCharterHash(),
      caps: decision.capabilities,
      detail: `reused ${skillName}`,
      source,
    });

    if (goalId && source === "live") {
      const parsed = parseListingStdout(result.stdout);
      if (parsed.rawCount > 0) {
        await appendListingBatch(goalId, skillName, query, parsed.usable, {
          rawCount: parsed.rawCount,
          hubCount: parsed.hubCount,
        });
      }
    }

    const summary = formatNewsReply(`Reused ${skillName}.`, result.stdout);
    return { kind: "job", job, outcome: "reuse", skill: skillName, reply: summary };
  } finally {
    releaseCall?.();
  }
}

async function runCreate(
  job: Job,
  forgeOverride: TalkFixture["forge"] | undefined,
  source?: "live" | "fixture",
  gapLogged = false,
): Promise<TalkResult> {
  // Never place real Bland calls during Create forge/test/install.
  return runWithProvisionalScope(() =>
    runWithOutboundBlocked(() =>
      runCreateInner(job, forgeOverride, source, gapLogged),
    ),
  );
}

async function runCreateInner(
  job: Job,
  forgeOverride: TalkFixture["forge"] | undefined,
  source?: "live" | "fixture",
  gapLogged = false,
): Promise<TalkResult> {
  const runId = randomUUID().slice(0, 8);
  const runDir = dataPath("staging", runId);
  mkdirSync(runDir, { recursive: true });

  if (!gapLogged) {
    appendLog({
      actor: "runner",
      event: "gap",
      skill: null,
      decision: "allow",
      charterHash: getCharterHash(),
      detail: "no installed skill covers <intent> → create",
      source,
    });
  }

  let artifact: ForgeArtifact;
  try {
    if (forgeOverride) {
      artifact = ensureRunnableSkillSource(
        { ...forgeOverride, skillSource: forgeOverride.skillSource || defaultNewsSkillSource() },
        job.intent,
      );
    } else if (process.env.JUDGE_MODE === "1") {
      const candidates = [
        job.skill ? `${job.skill}.json` : null,
        job.needs.includes("notify:phone") ? "place_outbound_call.json" : null,
        "pull_company_news.json",
      ].filter((n): n is string => Boolean(n));
      let fx: ForgeArtifact | null = null;
      for (const name of candidates) {
        fx = loadForgeFixture(name);
        if (fx) break;
      }
      artifact = fx
        ? ensureRunnableSkillSource(
            { ...fx, skillSource: fx.skillSource || defaultNewsSkillSource() },
            job.intent,
          )
        : await forgeSkill(job.intent, job.query, job.skill);
  } else {
    artifact = await forgeSkill(job.intent, job.query, job.skill);
    }
    if (!forgeOverride && job.skill) {
      artifact = { ...artifact, name: job.skill };
    }
    if (!artifact.query) artifact = { ...artifact, query: job.query };
  } catch {
    wipeStaging(runDir);
    appendLog({
      actor: "forge",
      event: "broken",
      skill: null,
      decision: "fail",
      failureCode: "forge_invalid",
      charterHash: getCharterHash(),
      voice: "voice/broken.wav",
      source,
    });
    return {
      kind: "job",
      job,
      outcome: "broken",
      skill: null,
      failureCode: "forge_invalid",
      reply: replyFor("forge_invalid", "Forge failed."),
    };
  }

  let skillName: string;
  let testQuery: string;
  let freeform = false;
  try {
    const written = writeForgedSkill(artifact, runDir, skillsRoot());
    skillName = written.skillName;
    testQuery = written.testQuery || job.query;
    freeform = written.freeform;
  } catch {
    wipeStaging(runDir);
    appendLog({
      actor: "forge",
      event: "broken",
      skill: null,
      decision: "fail",
      failureCode: "forge_invalid",
      charterHash: getCharterHash(),
      voice: "voice/broken.wav",
      source,
    });
    return {
      kind: "job",
      job,
      outcome: "broken",
      skill: null,
      failureCode: "forge_invalid",
      reply: replyFor("forge_invalid", "Forge write failed."),
    };
  }

  appendLog({
    actor: "forge",
    event: "forge",
    skill: skillName,
    decision: "allow",
    charterHash: getCharterHash(),
    detail: freeform ? "freeform skillSource" : "params into http template",
    source,
  });

  const needs = job.needs.length ? job.needs : ["net:fetch"];
  const pre = wardenPre(runDir, { ...job, needs }, skillName);
  if (!pre.ok) {
    denyAndWipe(runDir, skillName, pre.failureCode, pre.caps, pre.detail);
    return {
      kind: "job",
      job,
      outcome: "denied",
      skill: skillName,
      failureCode: pre.failureCode,
      reply: replyFor(pre.failureCode, "Denied."),
    };
  }

  const isCall = pre.caps.includes("notify:phone");
  // Create-path call hands: skip live dial (rate limit + real outbound); warden-only.
  if (!isCall) {
    const input: { query: string; baseUrl?: string } = { query: testQuery };
    const base = offlineBaseUrl(pre.caps);
    if (base) input.baseUrl = base;

    const result = await runSkill(
      path.join(runDir, "skill.mjs"),
      runDir,
      input,
      provisionalOr(grantKeysForCaps(pre.caps)),
      15_000,
    );

    if (result.timedOut || !result.ok) {
      const code = result.timedOut ? "timeout" : "test_exit_nonzero";
      appendLog({
        actor: "test",
        event: "broken",
        skill: skillName,
        decision: "fail",
        failureCode: code,
        charterHash: getCharterHash(),
        voice: "voice/broken.wav",
        source,
      });
      clearProvisionalGrant();
      wipeStaging(runDir);
      return {
        kind: "job",
        job,
        outcome: "broken",
        skill: skillName,
        failureCode: code,
        reply: replyFor(code, "Test failed."),
      };
    }

    const validated = validateHttpOutput(result.stdout);
    if (!validated.ok) {
      appendLog({
        actor: "test",
        event: "broken",
        skill: skillName,
        decision: "fail",
        failureCode: "schema_invalid",
        charterHash: getCharterHash(),
        voice: "voice/broken.wav",
        detail: validated.reason,
        source,
      });
      clearProvisionalGrant();
      wipeStaging(runDir);
      return {
        kind: "job",
        job,
        outcome: "broken",
        skill: skillName,
        failureCode: "schema_invalid",
        reply: replyFor("schema_invalid", "Bad schema."),
      };
    }

    appendLog({
      actor: "test",
      event: "test",
      skill: skillName,
      decision: "pass",
      charterHash: getCharterHash(),
      detail: `pass · ${validated.data.items.length} items`,
      source,
    });
  } else {
    appendLog({
      actor: "test",
      event: "test",
      skill: skillName,
      decision: "pass",
      charterHash: getCharterHash(),
      detail: "skipped live call test · notify:phone · warden-only install",
      source,
    });
  }

  const fin = wardenFinal(runDir, skillName, pre.folderHash, pre.caps);
  if (!fin.ok) {
    denyAndWipe(runDir, skillName, fin.failureCode, fin.caps, fin.detail);
    return {
      kind: "job",
      job,
      outcome: "denied",
      skill: skillName,
      failureCode: fin.failureCode,
      reply: replyFor(fin.failureCode, "Denied."),
    };
  }

  installSkill(runDir, skillName, fin.caps, fin.folderHash, skillsRoot());
  return {
    kind: "job",
    job,
    outcome: "install",
    skill: skillName,
    reply: formatNewsReply(
      `Grew ${skillName} and ran it.`,
      result.stdout,
    ),
  };
}

async function runEmailDenied(source?: "live" | "fixture"): Promise<TalkResult> {
  return runWithProvisionalScope(async () => {
    const job: Job = {
      skill: null,
      intent: "email digest",
      query: "news digest",
      needs: ["notify:email"],
      template: "email_send",
    };
    const runId = randomUUID().slice(0, 8);
    const runDir = dataPath("staging", runId);
    copyEmailSendTemplate(runDir);

    appendLog({
      actor: "forge",
      event: "forge",
      skill: "email_send",
      decision: "allow",
      charterHash: getCharterHash(),
      detail: "fixed template, no LLM",
      source,
    });

    const pre = wardenPre(runDir, job, "email_send", { skipLogPrecheck: true });
    if (!pre.ok) {
      denyAndWipe(runDir, "email_send", pre.failureCode, pre.caps, pre.detail);
      return {
        kind: "job",
        job,
        outcome: "denied",
        skill: "email_send",
        failureCode: pre.failureCode,
        reply: replyFor(pre.failureCode, "Denied."),
      };
    }
    // Should not allow
    wipeStaging(runDir);
    return {
      kind: "job",
      job,
      outcome: "broken",
      skill: "email_send",
      failureCode: "forge_invalid",
      reply: "Unexpected allow on email_send.",
    };
  });
}

/**
 * Runner path for `run_skill`.
 * Live: Reuse only — Create/Install is Doctor-only (`doctor_required`).
 * Fixture + forge override: still Create for JUDGE/validate demos.
 */
export async function executeJob(
  job: Job,
  forge?: TalkFixture["forge"],
  source?: "live" | "fixture",
  goalId?: string,
): Promise<TalkResult> {
  appendLog({
    actor: "talk",
    event: "job",
    skill: job.skill,
    decision: "allow",
    charterHash: getCharterHash(),
    detail: job.query,
    source,
  });

  const choice = chooseReuse(job);
  if (choice.mode === "reuse") {
    return runReuse(choice.skill, job, source, choice.detail, goalId);
  }

  // Fixture inject-forge still exercises Create; live (and fixture without forge) must use Doctor.
  const allowFixtureCreate = source === "fixture" && !!forge;
  if (allowFixtureCreate) {
    appendLog({
      actor: "runner",
      event: "gap",
      skill: null,
      decision: "allow",
      charterHash: getCharterHash(),
      detail: choice.detail,
      source,
    });
    return runCreate(job, forge, source, /* gapLogged */ true);
  }

  appendLog({
    actor: "runner",
    event: "gap",
    skill: job.skill,
    decision: "allow",
    failureCode: "doctor_required",
    charterHash: getCharterHash(),
    detail: `recognized gap · Doctor growing · ${choice.detail}`,
    source,
  });
  return {
    kind: "job",
    job,
    outcome: "needs_capability",
    skill: job.skill,
    failureCode: "doctor_required",
    reply: replyFor("doctor_required", "Doctor required."),
  };
}

function growingSkillFromLoop(result: AgentLoopResult): string | null {
  for (let i = result.skillResults.length - 1; i >= 0; i--) {
    const r = result.skillResults[i]!;
    if (r.kind === "job" && r.outcome === "needs_capability" && r.skill) return r.skill;
  }
  const m = /Doctor forging ([a-z0-9_]+)/i.exec(result.text);
  return m?.[1] ?? null;
}

function loopResultToTalk(result: AgentLoopResult): TalkResult {
  if (result.status === "waiting") {
    return { kind: "chat", text: result.text };
  }
  const last = result.skillResults[result.skillResults.length - 1];
  if (last?.kind === "job") return last;
  return { kind: "chat", text: result.text };
}

/** Talk JSON + UI hints (waiting / growing limb). */
export type TalkApiResult = TalkResult & {
  goalId?: string;
  status?: AgentLoopResult["status"];
  growingSkill?: string | null;
};

async function runLoopFromActions(
  goalId: string,
  userText: string | undefined,
  actions: ReturnType<typeof talkEmitToActions>,
  forge: TalkFixture["forge"] | undefined,
  source: "live" | "fixture",
): Promise<TalkResult> {
  if (userText) {
    appendMessage({ goalId, role: "user", text: userText });
    syncHistory();
  }
  let planned = false;
  const loopResult = await runAgentLoop(
    { goalId, userText },
    {
      plan: async () => {
        if (planned) return [];
        planned = true;
        return actions;
      },
      runSkill: (job) => executeJob(job, forge, source, goalId),
    },
  );
  const talk = loopResultToTalk(loopResult);
  appendMessage({ goalId, role: "assistant", text: talkText(talk) });
  syncHistory();
  return talk;
}

/** Serialize Talk turns so overlapping POSTs cannot race history / park / grants. */
let talkMutex: Promise<void> = Promise.resolve();

async function withTalkMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = talkMutex;
  let release!: () => void;
  talkMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function handleTalk(text: string, fixtureName?: string): Promise<TalkApiResult> {
  return withTalkMutex(() => handleTalkUnlocked(text, fixtureName));
}

async function handleTalkUnlocked(
  text: string,
  fixtureName?: string,
): Promise<TalkApiResult> {
  // Explicit fixture file
  if (fixtureName) {
    const fx = loadTalkFixture(fixtureName);
    if (!fx) {
      const goalId = newGoalId(text);
      appendMessage({ goalId, role: "user", text });
      const r = { kind: "chat" as const, text: `Unknown fixture ${fixtureName}` };
      appendMessage({ goalId, role: "assistant", text: r.text });
      syncHistory();
      return { ...r, goalId };
    }
    return finishFromEmit(text, fx.talk, fx.forge, "fixture");
  }

  // Tripwire before Talk — DENIED specimen; no doctor / agent loop
  if (tripwireMatch(text)) {
    const goalId = newGoalId(text);
    appendMessage({ goalId, role: "user", text });
    const r = await runEmailDenied("live");
    appendMessage({ goalId, role: "assistant", text: talkText(r) });
    syncHistory();
    return { ...r, goalId };
  }

  const judged = findJudgeFixture(text);
  if (judged) {
    return finishFromEmit(text, judged.talk, judged.forge, "fixture");
  }

  // Live planner → host action loop (Doctor submit is non-blocking; wait parks)
  const goalId = newGoalId(text);
  appendMessage({ goalId, role: "user", text });
  syncHistory();
  const loopResult = await runAgentLoop(
    { goalId, userText: text },
    {
      plan: planAgentTurn,
      runSkill: (job) => executeJob(job, undefined, "live", goalId),
    },
  );
  await auditAppend({
    type: "agent.turn",
    goalId,
    summary: `Agent turn ${loopResult.status}`,
    data: {
      status: loopResult.status,
      steps: loopResult.steps,
      actionsExecuted: loopResult.actionsExecuted,
    },
  });
  const talk = loopResultToTalk(loopResult);
  appendMessage({
    goalId,
    role: "assistant",
    text: talkText(talk),
    skill: talk.kind === "job" ? talk.skill : null,
  });
  syncHistory();
  const api: TalkApiResult = {
    ...talk,
    goalId,
    status: loopResult.status,
    growingSkill: growingSkillFromLoop(loopResult),
  };
  return api;
}

async function finishFromEmit(
  userText: string,
  emit: TalkFixture["talk"],
  forge: TalkFixture["forge"] | undefined,
  source: "live" | "fixture",
): Promise<TalkResult> {
  const goalId = newGoalId(userText);
  // Tripwire still wins over fixture job if raw text matches — except denied-email fixture path uses tripwire via text
  if (tripwireMatch(userText) && source !== "fixture") {
    appendMessage({ goalId, role: "user", text: userText });
    const r = await runEmailDenied(source);
    appendMessage({ goalId, role: "assistant", text: r.reply });
    syncHistory();
    return r;
  }
  // For fixture denied-email, talk may be job — still run email path if needs notify
  if (emit.kind === "job" && emit.job.needs.includes("notify:email")) {
    appendMessage({ goalId, role: "user", text: userText });
    const r = await runEmailDenied(source);
    appendMessage({ goalId, role: "assistant", text: r.reply });
    syncHistory();
    return r;
  }
  if (tripwireMatch(userText)) {
    appendMessage({ goalId, role: "user", text: userText });
    const r = await runEmailDenied(source);
    appendMessage({ goalId, role: "assistant", text: r.reply });
    syncHistory();
    return r;
  }

  return runLoopFromActions(goalId, userText, talkEmitToActions(emit), forge, source);
}

/**
 * Boot agent event bridge + resume handler (no user text on wake).
 * Call once from server startup.
 */
export function startAgentRuntime(): () => void {
  rehydrateTranscript();
  return wireAgentResume({
    plan: planAgentTurn,
    runSkill: (job, goalId) => executeJob(job, undefined, "live", goalId),
    async onStart(wake: ResumeContext) {
      if (wake.event.type === "capability.ready" && wake.skill) {
        const more = wake.allSatisfied
          ? "all hands ready"
          : `${wake.remainingRequestIds.length} still growing`;
        appendMessage({
          goalId: wake.goalId,
          role: "status",
          skill: wake.skill,
          text: `Installed ${wake.skill} — continuing (${more})…`,
        });
        return;
      }
      if (wake.event.type === "capability.needs_secret") {
        appendMessage({
          goalId: wake.goalId,
          role: "status",
          text: "Waiting on a secret…",
        });
        return;
      }
      if (wake.event.type === "access.needs_connect") {
        appendMessage({
          goalId: wake.goalId,
          role: "status",
          text: `Waiting on Composio connect (${wake.event.toolkit})…`,
        });
        return;
      }
      if (wake.event.type === "access.ready") {
        appendMessage({
          goalId: wake.goalId,
          role: "status",
          text: `Connected ${wake.event.toolkit} — Doctor still forging…`,
        });
        return;
      }
      if (wake.event.type === "capability.failed") {
        appendMessage({
          goalId: wake.goalId,
          role: "status",
          text: `Capability failed (${wake.requestId ?? "unknown"})…`,
        });
        return;
      }
      if (wake.event.type === "access.failed") {
        appendMessage({
          goalId: wake.goalId,
          role: "status",
          text: `Composio access failed (${wake.event.toolkit})…`,
        });
        return;
      }
      if (wake.event.type === "schedule.fired") {
        appendMessage({
          goalId: wake.goalId,
          role: "status",
          text: `Schedule ${wake.event.scheduleId} fired…`,
        });
      }
    },
    async onResult(result: AgentLoopResult, wake: ResumeContext) {
      const skill =
        wake.skill ??
        (wake.event.type === "capability.ready" ? wake.event.skill : null);
      appendLog({
        actor: "talk",
        event: "job",
        skill,
        decision: "allow",
        charterHash: getCharterHash(),
        detail: `wake:${wake.event.type}:${result.status}:${wake.requestId ?? ""}`,
      });
      await auditAppend({
        type: "agent.resume",
        goalId: wake.goalId,
        summary: `Woke on ${wake.event.type}${skill ? ` → ${skill}` : ""}`,
        data: {
          eventType: wake.event.type,
          requestId: wake.requestId ?? null,
          skill: skill,
          status: result.status,
          allSatisfied: wake.allSatisfied,
        },
      });
      const text =
        result.text ||
        (result.skillResults.length
          ? result.skillResults
              .map((r) => (r.kind === "chat" ? r.text : r.reply))
              .filter(Boolean)
              .join("\n\n")
          : "");
      if (text) {
        appendMessage({
          goalId: wake.goalId,
          role: "assistant",
          skill,
          text: text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text,
        });
        syncHistory();
      } else if (wake.event.type === "capability.ready" && skill) {
        appendMessage({
          goalId: wake.goalId,
          role: "status",
          skill,
          text: `Finished ${skill} (${result.status}).`,
        });
      }
    },
  });
}
