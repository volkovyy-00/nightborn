import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FailureCode, HandResult, Item, Job, Manifest, TalkResult, TalkStats } from "./types.ts";
import { getCharterHash } from "./charter.ts";
import { appendLog } from "./log.ts";
import { dataPath } from "./paths.ts";
import { tripwireMatch } from "./tripwire.ts";
import { chatReply, itemsReply, replyFor } from "./replies.ts";
import { deniedNeeds, denyAndWipe, installSkill, wardenDeny, wardenFinal, wardenPre, wardenReuse, wipeStaging } from "./warden.ts";
import { coerceInputs, copyEmailSendTemplate, forgeFromFixture, prepareRecipe, renderRecipe, type ForgeResult } from "./forge.ts";
import { exploreRecipe } from "./explorer.ts";
import { buildSnapshot, findJudgeFixture, loadTalkFixture, recordTurn, talk } from "./talk.ts";
import { runSkill } from "./exec.ts";
import { parseItems, validateOutput } from "../templates/schemas.ts";
import { brokerGrant, clearProvisionalGrant, getProvisionalGrant, setProvisionalGrant } from "./broker.ts";

// Runner: tripwire + Runner rule (SPEC §9), deterministic, no LLM. Writes each log line when its step happens.

type Source = "live" | "fixture";
type Ctx = { source: Source; fixturePath: boolean };

const BROKEN_VOICE = "voice/broken.wav";
const ITEMS_MAX = 5;

function skillsRoot(): string {
  return dataPath("skills");
}

function offline(): boolean {
  return process.env.OFFLINE === "1";
}

/** OFFLINE: skills fetch `new URL(u.host + u.pathname + u.search, baseUrl)` from Hono's /mock/. */
function stdinExtras(): { baseUrl?: string } {
  return offline() ? { baseUrl: `http://127.0.0.1:${process.env.PORT ?? "8787"}/mock/` } : {};
}

function runHosts(hosts: string[]): string[] {
  return offline() ? [...hosts, "127.0.0.1"] : hosts;
}

function line(l: Omit<Parameters<typeof appendLog>[0], "charterHash">, ctx: Ctx): void {
  appendLog({ ...l, charterHash: getCharterHash(), ...(ctx.source === "fixture" ? { source: "fixture" } : {}) });
}

function broken(skill: string | null, code: FailureCode, detail: string, ctx: Ctx, actor: "runner" | "test" | "forge" = "runner"): HandResult {
  line({ actor, event: "broken", skill, decision: "fail", failureCode: code, voice: BROKEN_VOICE, detail }, ctx);
  return { outcome: "broken", skill, failureCode: code };
}

/** Classify a finished skill run: Broken codes per SPEC §9 "Test and Reuse runs". */
function runFailure(r: Awaited<ReturnType<typeof runSkill>>): { code: FailureCode; detail: string } | null {
  if (r.timedOut) return { code: "timeout", detail: "run: timeout" };
  if (r.overflow) return { code: "test_exit_nonzero", detail: "run: output cap" };
  if (!r.ok) return { code: "test_exit_nonzero", detail: `run: exit ${r.code ?? "signal"}` };
  return null;
}

function readManifest(name: string): Manifest | null {
  const p = path.join(skillsRoot(), name, "manifest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function nullishSkill(s: string | null | undefined): boolean {
  return s === null || s === undefined || s.trim() === "" || s.trim() === "null";
}

// ── Reuse ────────────────────────────────────────────────────────────────

async function reuse(name: string, inputs: Job["inputs"], ctx: Ctx): Promise<HandResult> {
  const t0 = Date.now();
  line({ actor: "runner", event: "matched", skill: name, decision: "allow", detail: "by name" }, ctx);
  const dir = path.join(skillsRoot(), name);
  const decision = wardenReuse(dir, name);
  if (!decision) return { outcome: "denied", skill: name, failureCode: "hash_mismatch" };

  const r = await runSkill(
    path.join(dir, "skill.mjs"),
    dir,
    { inputs, max: ITEMS_MAX, ...stdinExtras() },
    brokerGrant(decision.env),
    runHosts(decision.hosts),
  );
  const fail = runFailure(r);
  if (fail) return broken(name, fail.code, fail.detail, ctx);
  const parsed = parseItems(r.stdout);
  if (!parsed.ok) return broken(name, "schema_invalid", `run: ${parsed.reason}`, ctx);
  const ms = Date.now() - t0;
  line(
    {
      actor: "runner",
      event: "reuse",
      skill: name,
      decision: "allow",
      caps: decision.capabilities,
      detail: `${parsed.items.length} items · hand ran with 0 LLM tokens`,
      tokens: 0,
      costUsd: 0,
      ms,
    },
    ctx,
  );
  return { outcome: "reuse", skill: name, items: parsed.items.slice(0, ITEMS_MAX), forgeTokens: 0, ms };
}

// ── Create: gap → forge → PRE → Test → FINAL → Install ──────────────────

async function create(job: Job, gapDetail: string, ctx: Ctx): Promise<HandResult> {
  const t0 = Date.now();
  const named = nullishSkill(job.skill) ? null : job.skill;
  line({ actor: "runner", event: "gap", skill: named, decision: "allow", detail: gapDetail }, ctx);

  // Explorer steps are `forge` lines without tokens; the session total lands on the pass/fail line below (SPEC §12).
  const step = (detail: string, ms?: number) =>
    line({ actor: "forge", event: "forge", skill: named, decision: "pass", detail, ...(ms !== undefined ? { ms } : {}) }, ctx);
  const forge: ForgeResult = offline() || ctx.fixturePath ? forgeFromFixture(job) : await exploreRecipe(job, step);
  const fctx: Ctx = forge.source === "fixture" ? { ...ctx, source: "fixture" } : ctx;
  if (!forge.ok) {
    line({ actor: "forge", event: "forge", skill: named, decision: "fail", detail: forge.reason, tokens: forge.tokens, costUsd: forge.costUsd, ms: forge.ms }, fctx);
    const r = broken(named, "forge_invalid", forge.reason, fctx);
    return { ...r, forgeTokens: forge.tokens, forgeCostUsd: forge.costUsd };
  }
  const prepared = prepareRecipe(forge.recipe, job, forge.visited, skillsRoot());
  if (!prepared.ok) {
    line({ actor: "forge", event: "forge", skill: named, decision: "fail", detail: prepared.reason, tokens: forge.tokens, costUsd: forge.costUsd, ms: forge.ms }, fctx);
    const r = broken(named, "forge_invalid", prepared.reason, fctx);
    return { ...r, forgeTokens: forge.tokens, forgeCostUsd: forge.costUsd };
  }
  const { hand } = prepared;
  line(
    {
      actor: "forge",
      event: "forge",
      skill: hand.name,
      decision: "pass",
      detail:
        hand.manifest.recipe?.endpoint === "json"
          ? `recipe: json ${hand.manifest.hosts.join(", ")}`
          : `recipe: ${hand.manifest.recipe?.endpoint} "${hand.manifest.recipe?.queryPattern}"`,
      tokens: forge.tokens,
      costUsd: forge.costUsd,
      ms: forge.ms,
    },
    fctx,
  );
  const runId = randomUUID().slice(0, 8);
  const runDir = dataPath("staging", runId);
  const done = (r: HandResult): HandResult => ({ ...r, forgeTokens: forge.tokens, forgeCostUsd: forge.costUsd, ms: Date.now() - t0 });
  try {
    renderRecipe(hand, runDir);
  } catch {
    wipeStaging(runDir);
    return done(broken(hand.name, "forge_invalid", "render: failed", fctx));
  }

  try {
    const pre = wardenPre(runDir, { job, name: hand.name, visited: forge.visited });
    if (!pre.ok) {
      denyAndWipe(runDir, hand.name, pre.failureCode, pre.caps, pre.detail);
      return done({ outcome: "denied", skill: hand.name, failureCode: pre.failureCode });
    }
    setProvisionalGrant(runId, pre.env);
    const r = await runSkill(
      path.join(runDir, "skill.mjs"),
      runDir,
      { inputs: hand.testInputs, max: ITEMS_MAX, ...stdinExtras() },
      brokerGrant(getProvisionalGrant(runId)),
      runHosts(hand.manifest.hosts),
    );
    const fail = runFailure(r);
    if (fail) {
      wipeStaging(runDir);
      return done(broken(hand.name, fail.code, `test: ${fail.detail.replace(/^run: /, "")}`, fctx, "test"));
    }
    const v = validateOutput(r.stdout);
    if (!v.ok) {
      wipeStaging(runDir);
      return done(broken(hand.name, "schema_invalid", `test: ${v.reason}`, fctx, "test"));
    }
    line({ actor: "test", event: "test", skill: hand.name, decision: "pass", detail: `${v.items.length} items`, ms: r.ms }, fctx);

    if (!wardenFinal(runDir, hand.name, pre.folderHash, pre.caps)) {
      denyAndWipe(runDir, hand.name, "hash_mismatch", pre.caps, "FINAL hash != PRE");
      return done({ outcome: "denied", skill: hand.name, failureCode: "hash_mismatch" });
    }
    installSkill(runDir, skillsRoot(), pre, { tokens: forge.tokens, costUsd: forge.costUsd, ms: Date.now() - t0 });
    return done({ outcome: "install", skill: hand.name, items: v.items.slice(0, ITEMS_MAX) });
  } catch {
    // Unexpected I/O or parse failure: still exactly one outcome, staging wiped, no raw error text.
    wipeStaging(runDir);
    return done(broken(hand.name, "forge_invalid", "runner: internal error", fctx));
  } finally {
    clearProvisionalGrant(runId);
  }
}

// ── Runner rule (SPEC §9), steps 2–6; step 1 (tripwire) runs before Talk ─

export async function runJob(rawJob: Job, stats: TalkStats, ctx: Ctx): Promise<HandResult> {
  const job: Job = {
    skill: nullishSkill(rawJob.skill) ? null : String(rawJob.skill).trim(),
    intent: String(rawJob.intent ?? "").slice(0, 200),
    inputs: rawJob.inputs && typeof rawJob.inputs === "object" ? rawJob.inputs : {},
    needs: Array.isArray(rawJob.needs) ? [...new Set(rawJob.needs.map(String))] : [],
  };
  line(
    {
      actor: ctx.fixturePath ? "runner" : "talk",
      event: "job",
      skill: job.skill,
      decision: "allow",
      caps: job.needs,
      detail: `use_hand: ${job.intent}`.slice(0, 120),
      tokens: stats.tokens,
      costUsd: stats.costUsd,
    },
    ctx,
  );

  // 2. needs outside the charter → DENIED, no staging
  const denied = deniedNeeds(job);
  if (denied.length) {
    wardenDeny(job.skill, "capability_not_allowed", denied, "triggers: job_needs");
    return { outcome: "denied", skill: job.skill, failureCode: "capability_not_allowed" };
  }
  // 3. invalid name → DENIED
  if (job.skill !== null && !/^[a-z0-9_]{1,40}$/.test(job.skill)) {
    wardenDeny(null, "invalid_skill_name", [], "name");
    return { outcome: "denied", skill: null, failureCode: "invalid_skill_name" };
  }
  try {
    return await dispatch(job, ctx);
  } catch {
    return broken(job.skill, "forge_invalid", "runner: internal error", ctx);
  }
}

async function dispatch(job: Job, ctx: Ctx): Promise<HandResult> {
  // 4. installed hand → validate inputs → Reuse, else Create
  if (job.skill !== null) {
    const manifest = readManifest(job.skill);
    if (manifest) {
      const inputs = coerceInputs(manifest.inputs ?? [], job.inputs);
      if (inputs) return reuse(job.skill, inputs, ctx);
      return create(job, `inputs don't fit ${job.skill} → create`, ctx);
    }
    // 5. named hand not installed → Create
    return create(job, `named skill ${job.skill} not installed → create`, ctx);
  }
  // 6. null → Create
  return create(job, `no installed hand covers ${job.intent || "this"} → create`, ctx);
}

// ── Tripwire path (SPEC §11) ─────────────────────────────────────────────

const EMAIL_JOB: Job = { skill: null, intent: "email digest", inputs: {}, needs: ["notify:email"], template: "email_send" };

function emailDenied(ctx: Ctx): HandResult {
  line({ actor: "runner", event: "job", skill: null, decision: "allow", caps: EMAIL_JOB.needs, detail: "tripwire → email_send" }, ctx);
  const runDir = dataPath("staging", randomUUID().slice(0, 8));
  copyEmailSendTemplate(runDir);
  line({ actor: "forge", event: "forge", skill: "email_send", decision: "pass", detail: "fixed template, no LLM" }, ctx);
  const pre = wardenPre(runDir, { job: EMAIL_JOB, name: "email_send", visited: [] });
  if (pre.ok) {
    // Cannot happen while the charter denies notify:email; never install the email template.
    wipeStaging(runDir);
    return { outcome: "denied", skill: "email_send", failureCode: "capability_not_allowed" };
  }
  denyAndWipe(runDir, "email_send", pre.failureCode, pre.caps, pre.detail);
  return { outcome: "denied", skill: "email_send", failureCode: pre.failureCode };
}

// ── POST /api/talk ───────────────────────────────────────────────────────

function toResult(job: Job, r: HandResult, reply: string, talkTokens: number, t0: number): TalkResult {
  return {
    kind: "job",
    job,
    outcome: r.outcome,
    skill: r.skill,
    ...(r.failureCode ? { failureCode: r.failureCode } : {}),
    reply,
    ...(r.items ? { items: r.items.map((i: Item) => ({ title: i.title, url: i.url, ...(i.snippet ? { snippet: i.snippet } : {}), ...(i.date ? { date: i.date } : {}) })) } : {}),
    tokens: { talk: talkTokens, forge: r.forgeTokens ?? 0 },
    ms: Date.now() - t0,
  };
}

function templatedReply(r: HandResult): string {
  return r.outcome === "denied" || r.outcome === "broken" ? replyFor(r.failureCode ?? "forge_invalid") : itemsReply(r.items ?? []);
}

export async function handleTalk(text: string, fixture?: string): Promise<TalkResult> {
  const t0 = Date.now();

  // 1. Tripwire on raw text, before Talk
  if (tripwireMatch(text)) {
    const r = emailDenied({ source: "live", fixturePath: false });
    const reply = replyFor(r.failureCode ?? "capability_not_allowed");
    recordTurn(text, reply); // Talk's last-5-turns history includes Talk-skipped exchanges
    return toResult(EMAIL_JOB, r, reply, 0, t0);
  }

  // Fixture path (chip backups / JUDGE_MODE): Talk skipped, tokens.talk = 0 (SPEC §10)
  const fx = fixture ? loadTalkFixture(fixture) : findJudgeFixture(text);
  if (fx) {
    const ctx: Ctx = { source: "fixture", fixturePath: true };
    const job: Job = { ...fx.useHand };
    const r = await runJob(job, { tokens: 0, costUsd: 0 }, ctx);
    const reply = templatedReply(r);
    recordTurn(text, reply);
    return toResult(job, r, reply, 0, t0);
  }

  // Live Talk
  const out = await talk(text, {
    snapshot: buildSnapshot,
    runJob: (job, stats) => runJob(job, stats, { source: "live", fixturePath: false }),
  });
  if (out.kind === "chat") return { kind: "chat", text: out.text };
  if (out.kind === "fail") {
    appendLog({ actor: "talk", event: "job", skill: null, decision: "fail", charterHash: getCharterHash(), detail: out.reason, tokens: out.tokens, costUsd: out.costUsd });
    return { kind: "chat", text: chatReply(out.reason) };
  }
  return toResult(out.job, out.result, out.reply, out.tokens, t0);
}
