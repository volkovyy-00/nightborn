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
  forgeSkillViaPi,
  loadForgeFixture,
  writeForgedSkill,
} from "./forge.ts";
import {
  findJudgeFixture,
  loadTalkFixture,
  planAgentTurn,
  pushHistory,
  talkEmitToActions,
  type TalkFixture,
} from "./talk.ts";
import type { ForgeArtifact } from "./types.ts";
import { runSkill } from "./exec.ts";
import { validateHttpOutput } from "../templates/schemas.ts";
import { clearProvisionalGrant, grantKeysForCaps, provisionalOr } from "./broker.ts";
import {
  newGoalId,
  runAgentLoop,
  wireAgentResume,
  type AgentLoopResult,
} from "./agent/loop.ts";
import { append as auditAppend } from "./audit.ts";
import type { ResumeContext } from "./agent/resume.ts";

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
  if (!items.length) return prefix;
  const lines = items.slice(0, 5).map((it, i) => {
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

  const input: { query: string; baseUrl?: string } = { query: job.query };
  const base = offlineBaseUrl(decision.capabilities);
  if (base) input.baseUrl = base;

  const result = await runSkill(path.join(dir, "skill.mjs"), dir, input, decision.env, 15_000);
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

  const summary = formatNewsReply(`Reused ${skillName}.`, result.stdout);
  return { kind: "job", job, outcome: "reuse", skill: skillName, reply: summary };
}

async function runCreate(
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
        : await forgeSkillViaPi(job.intent, job.query, job.skill);
    } else {
      artifact = await forgeSkillViaPi(job.intent, job.query, job.skill);
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
}

/** Existing Runner Create/Reuse path — used as sequential `run_skill` by the agent loop. */
export async function executeJob(
  job: Job,
  forge?: TalkFixture["forge"],
  source?: "live" | "fixture",
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
    return runReuse(choice.skill, job, source, choice.detail);
  }
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

function loopResultToTalk(result: AgentLoopResult): TalkResult {
  if (result.status === "waiting") {
    return { kind: "chat", text: result.text };
  }
  const last = result.skillResults[result.skillResults.length - 1];
  if (last?.kind === "job") return last;
  return { kind: "chat", text: result.text };
}

async function runLoopFromActions(
  goalId: string,
  userText: string | undefined,
  actions: ReturnType<typeof talkEmitToActions>,
  forge: TalkFixture["forge"] | undefined,
  source: "live" | "fixture",
): Promise<TalkResult> {
  let planned = false;
  const loopResult = await runAgentLoop(
    { goalId, userText },
    {
      plan: async () => {
        if (planned) return [];
        planned = true;
        return actions;
      },
      runSkill: (job) => executeJob(job, forge, source),
    },
  );
  const talk = loopResultToTalk(loopResult);
  pushHistory("assistant", talk.kind === "chat" ? talk.text : talk.reply);
  return talk;
}

export async function handleTalk(text: string, fixtureName?: string): Promise<TalkResult> {
  pushHistory("user", text);

  // Explicit fixture file
  if (fixtureName) {
    const fx = loadTalkFixture(fixtureName);
    if (!fx) {
      const r = { kind: "chat" as const, text: `Unknown fixture ${fixtureName}` };
      pushHistory("assistant", r.text);
      return r;
    }
    return finishFromEmit(text, fx.talk, fx.forge, "fixture");
  }

  // Tripwire before Talk — DENIED specimen; no doctor / agent loop
  if (tripwireMatch(text)) {
    const r = await runEmailDenied("live");
    pushHistory("assistant", r.kind === "chat" ? r.text : r.reply);
    return r;
  }

  const judged = findJudgeFixture(text);
  if (judged) {
    return finishFromEmit(text, judged.talk, judged.forge, "fixture");
  }

  // Live planner → host action loop (Doctor submit is non-blocking; wait parks)
  const goalId = newGoalId(text);
  const loopResult = await runAgentLoop(
    { goalId, userText: text },
    {
      plan: planAgentTurn,
      runSkill: (job) => executeJob(job, undefined, "live"),
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
  pushHistory("assistant", talk.kind === "chat" ? talk.text : talk.reply);
  return talk;
}

async function finishFromEmit(
  userText: string,
  emit: TalkFixture["talk"],
  forge: TalkFixture["forge"] | undefined,
  source: "live" | "fixture",
): Promise<TalkResult> {
  // Tripwire still wins over fixture job if raw text matches — except denied-email fixture path uses tripwire via text
  if (tripwireMatch(userText) && source !== "fixture") {
    const r = await runEmailDenied(source);
    pushHistory("assistant", r.reply);
    return r;
  }
  // For fixture denied-email, talk may be job — still run email path if needs notify
  if (emit.kind === "job" && emit.job.needs.includes("notify:email")) {
    const r = await runEmailDenied(source);
    pushHistory("assistant", r.reply);
    return r;
  }
  if (tripwireMatch(userText)) {
    const r = await runEmailDenied(source);
    pushHistory("assistant", r.reply);
    return r;
  }

  const goalId = newGoalId(userText);
  return runLoopFromActions(goalId, userText, talkEmitToActions(emit), forge, source);
}

/**
 * Boot agent event bridge + resume handler (no user text on wake).
 * Call once from server startup.
 */
export function startAgentRuntime(): () => void {
  return wireAgentResume({
    plan: planAgentTurn,
    runSkill: (job) => executeJob(job, undefined, "live"),
    async onResult(result: AgentLoopResult, resume: ResumeContext) {
      appendLog({
        actor: "talk",
        event: "job",
        skill: resume.skill,
        decision: "allow",
        charterHash: getCharterHash(),
        detail: `resume:${result.status}:${resume.requestId}`,
      });
      await auditAppend({
        type: "agent.resume",
        goalId: resume.goalId,
        summary: `Resumed on capability.ready → ${resume.skill}`,
        data: {
          requestId: resume.requestId,
          skill: resume.skill,
          status: result.status,
          allSatisfied: resume.allSatisfied,
        },
      });
      if (result.text) pushHistory("assistant", result.text);
    },
  });
}
