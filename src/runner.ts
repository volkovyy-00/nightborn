import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FailureCode, HandResult, InputValues, Item, Job, Manifest, TalkResult, TalkStats } from "./types.ts";
import { buildCode, type BuildCodeFn } from "./builder.ts";
import { getCharterHash } from "./charter.ts";
import { appendLog } from "./log.ts";
import { dataPath } from "./paths.ts";
import { tripwireMatch } from "./tripwire.ts";
import { chatReply, chatSay, itemsReply, replyFor, sayFor } from "./replies.ts";
import { deniedNeeds, denyAndWipe, installSkill, wardenDeny, wardenFinal, wardenPre, wardenReuse, wipeStaging } from "./warden.ts";
import { coerceInputs, copyEmailSendTemplate, forgeFromFixture, prepareRecipe, renderRecipe, type ForgeResult } from "./forge.ts";
import { exploreRecipe } from "./explorer.ts";
import { buildSnapshot, findJudgeFixture, loadTalkFixture, recordTurn, talk } from "./talk.ts";
import { runFailure, runSkill } from "./exec.ts";
import { parseItems, validateOutput } from "../templates/schemas.ts";
import { brokerGrant, clearProvisionalGrant, getProvisionalGrant, setProvisionalGrant } from "./broker.ts";

// Runner: tripwire + Runner rule (SPEC §9), deterministic, no LLM. Writes each log line when its step happens.

type Source = "live" | "fixture";
type Ctx = { source: Source; fixturePath: boolean; request?: string }; // request = the user's words, for the Explorer

/** Injectable forge dependencies (validate.ts injects a failing Builder to prove the fallback). */
export type RunnerDeps = { buildCode: BuildCodeFn | null };

const BROKEN_VOICE = "voice/broken.wav";
const ITEMS_MAX = 5;
const TALK_BUDGET_MS = 300_000; // POST /api/talk cap (SPEC §9 "Timeouts")
const FALLBACK_RESERVE_MS = 45_000; // Test + FINAL + Talk summary after a fallback Explorer

/** SPEC §9: code forge is online-only; OFFLINE and fixture requests always take the recipe path. */
function defaultDeps(ctx: Ctx): RunnerDeps {
  return { buildCode: process.env.FORGE_MODE === "code" && !offline() && !ctx.fixturePath ? buildCode : null };
}

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

type ForgeCost = { tokens: number; costUsd: number; ms: number };

/** The staged hand handed from the forge phase to PRE → Test → FINAL → Install. */
type Staged = { job: Job; name: string; runDir: string; hosts: string[]; testInputs: InputValues; visited: string[]; forge: ForgeCost; ctx: Ctx; t0: number };

/** Warden PRE → provisional grant → sandboxed Test → FINAL (= PRE) → Install. One outcome, staging wiped on every failure. */
async function testAndInstall(s: Staged): Promise<HandResult> {
  const { job, name, runDir, ctx, forge } = s;
  const runId = path.basename(runDir);
  const done = (r: HandResult): HandResult => ({ ...r, forgeTokens: forge.tokens, forgeCostUsd: forge.costUsd, ms: Date.now() - s.t0 });
  try {
    const pre = wardenPre(runDir, { job, name, visited: s.visited });
    if (!pre.ok) {
      denyAndWipe(runDir, name, pre.failureCode, pre.caps, pre.detail);
      return done({ outcome: "denied", skill: name, failureCode: pre.failureCode });
    }
    setProvisionalGrant(runId, pre.env);
    const r = await runSkill(
      path.join(runDir, "skill.mjs"),
      runDir,
      { inputs: s.testInputs, max: ITEMS_MAX, ...stdinExtras() },
      brokerGrant(getProvisionalGrant(runId)),
      runHosts(s.hosts),
    );
    const fail = runFailure(r);
    if (fail) {
      wipeStaging(runDir);
      return done(broken(name, fail.code, `test: ${fail.detail.replace(/^run: /, "")}`, ctx, "test"));
    }
    const v = validateOutput(r.stdout);
    if (!v.ok) {
      wipeStaging(runDir);
      return done(broken(name, "schema_invalid", `test: ${v.reason}`, ctx, "test"));
    }
    line({ actor: "test", event: "test", skill: name, decision: "pass", detail: `${v.items.length} items`, ms: r.ms }, ctx);

    if (!wardenFinal(runDir, name, pre.folderHash, pre.caps)) {
      denyAndWipe(runDir, name, "hash_mismatch", pre.caps, "FINAL hash != PRE");
      return done({ outcome: "denied", skill: name, failureCode: "hash_mismatch" });
    }
    installSkill(runDir, skillsRoot(), pre, { tokens: forge.tokens, costUsd: forge.costUsd, ms: Date.now() - s.t0 });
    return done({ outcome: "install", skill: name, items: v.items.slice(0, ITEMS_MAX) });
  } catch {
    // Unexpected I/O or parse failure: still exactly one outcome, staging wiped, no raw error text.
    wipeStaging(runDir);
    return done(broken(name, "forge_invalid", "runner: internal error", ctx));
  } finally {
    clearProvisionalGrant(runId);
  }
}

async function create(job: Job, gapDetail: string, ctx: Ctx, deps: RunnerDeps): Promise<HandResult> {
  const t0 = Date.now();
  const named = nullishSkill(job.skill) ? null : job.skill;
  line({ actor: "runner", event: "gap", skill: named, decision: "allow", detail: gapDetail }, ctx);

  // Explorer / Builder steps are `forge` lines without tokens; the session total lands on the pass/fail line (SPEC §12).
  const step = (detail: string, ms?: number) =>
    line({ actor: "forge", event: "forge", skill: named, decision: "pass", detail, ...(ms !== undefined ? { ms } : {}) }, ctx);

  // Code forge (SPEC §9 "Code forge"): the Builder writes the hand; a failure before submit_skill falls back to recipe once.
  const code = deps.buildCode ? await deps.buildCode(job, step, { stdinExtras, runHosts }, ctx.request) : null;
  if (code?.ok) {
    const forge: ForgeCost = { tokens: code.tokens, costUsd: code.costUsd, ms: code.ms };
    line({ actor: "forge", event: "forge", skill: code.name, decision: "pass", detail: `code: ${code.manifest.hosts.join(", ")}`, ...forge }, ctx);
    const testInputs = coerceInputs(code.manifest.inputs, job.inputs) ?? code.lastPassingInputs;
    return testAndInstall({ job, name: code.name, runDir: code.runDir, hosts: code.manifest.hosts, testInputs, visited: code.visited, forge, ctx, t0 });
  }
  // The Builder's session cost goes on its own `forge` line (per session, SPEC §12); the hand's total lands on `install`.
  const carry: ForgeCost = code ? { tokens: code.tokens, costUsd: code.costUsd, ms: code.ms } : { tokens: 0, costUsd: 0, ms: 0 };
  if (code) line({ actor: "forge", event: "forge", skill: named, decision: "fail", detail: `code failed: ${code.reason} → recipe`, ...carry }, ctx);

  // Recipe forge. After a code fallback the Explorer gets only what is left of the request budget (never more than the charter's cap).
  const explorerCap = code ? Math.floor((TALK_BUDGET_MS - (Date.now() - t0) - FALLBACK_RESERVE_MS) / 1000) : undefined;
  const recipe: ForgeResult = offline() || ctx.fixturePath ? forgeFromFixture(job) : await exploreRecipe(job, step, ctx.request, explorerCap);
  const fctx: Ctx = recipe.source === "fixture" ? { ...ctx, source: "fixture" } : ctx;
  const session: ForgeCost = { tokens: recipe.tokens, costUsd: recipe.costUsd, ms: recipe.ms };
  const forge: ForgeCost = { tokens: recipe.tokens + carry.tokens, costUsd: recipe.costUsd + carry.costUsd, ms: recipe.ms + carry.ms };
  const forgeFail = (reason: string): HandResult => {
    line({ actor: "forge", event: "forge", skill: named, decision: "fail", detail: reason, ...session }, fctx);
    return { ...broken(named, "forge_invalid", reason, fctx), forgeTokens: forge.tokens, forgeCostUsd: forge.costUsd };
  };
  if (!recipe.ok) return forgeFail(recipe.reason);
  const prepared = prepareRecipe(recipe.recipe, job, recipe.visited, skillsRoot());
  if (!prepared.ok) return forgeFail(prepared.reason);
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
      ...session,
    },
    fctx,
  );
  const runDir = dataPath("staging", randomUUID().slice(0, 8));
  try {
    renderRecipe(hand, runDir);
  } catch {
    wipeStaging(runDir);
    return { ...broken(hand.name, "forge_invalid", "render: failed", fctx), forgeTokens: forge.tokens, forgeCostUsd: forge.costUsd, ms: Date.now() - t0 };
  }
  return testAndInstall({ job, name: hand.name, runDir, hosts: hand.manifest.hosts, testInputs: hand.testInputs, visited: recipe.visited, forge, ctx: fctx, t0 });
}

// ── Runner rule (SPEC §9), steps 2–6; step 1 (tripwire) runs before Talk ─

export async function runJob(rawJob: Job, stats: TalkStats, ctx: Ctx, deps: RunnerDeps = defaultDeps(ctx)): Promise<HandResult> {
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
    return await dispatch(job, ctx, deps);
  } catch {
    return broken(job.skill, "forge_invalid", "runner: internal error", ctx);
  }
}

async function dispatch(job: Job, ctx: Ctx, deps: RunnerDeps): Promise<HandResult> {
  // 4. installed hand → validate inputs → Reuse, else Create
  if (job.skill !== null) {
    const manifest = readManifest(job.skill);
    if (manifest) {
      const inputs = coerceInputs(manifest.inputs ?? [], job.inputs);
      if (inputs) return reuse(job.skill, inputs, ctx);
      return create(job, `inputs don't fit ${job.skill} → create`, ctx, deps);
    }
    // 5. named hand not installed → Create
    return create(job, `named skill ${job.skill} not installed → create`, ctx, deps);
  }
  // 6. null → Create
  return create(job, `no installed hand covers ${job.intent || "this"} → create`, ctx, deps);
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

/** `voice` = Talk's own VOICE: line; otherwise the code template (none for denied / broken). */
function toResult(job: Job, r: HandResult, reply: string, talkTokens: number, t0: number, voice?: string): TalkResult {
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
    say: voice ?? sayFor(r),
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
    runJob: (job, stats) => runJob(job, stats, { source: "live", fixturePath: false, request: text }),
  });
  if (out.kind === "chat") return { kind: "chat", text: out.text, say: out.voice ?? chatSay(out.text) };
  if (out.kind === "fail") {
    appendLog({ actor: "talk", event: "job", skill: null, decision: "fail", charterHash: getCharterHash(), detail: out.reason, tokens: out.tokens, costUsd: out.costUsd });
    return { kind: "chat", text: chatReply(out.reason) };
  }
  return toResult(out.job, out.result, out.reply, out.tokens, t0, out.voice);
}
