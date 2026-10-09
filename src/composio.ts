/**
 * Skill-scoped Composio gateway.
 *
 * COMPOSIO_API_KEY stays on the host (never Broker-granted to skills).
 * Forge requests access for the skill under forge; runtime uses the same
 * nightborn:skill:<name> session via host proxy.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Composio } from "@composio/core";
import { getCharterHash } from "./charter.ts";
import { emit } from "./events.ts";
import { appendLog } from "./log.ts";
import { dataPath } from "./paths.ts";
import type { ComposioSkillBinding, DecisionJson } from "./types.ts";

export type { ComposioSkillBinding };

/** Marketplace toolkits Nightborn may connect / execute via Composio. */
export const COMPOSIO_ALLOWED_TOOLKITS = new Set(["apify"]);

/**
 * Explicit denials — email/SMTP must never ride Composio past the DENIED demo.
 * Checked before the allow-list so typos cannot widen access.
 */
export const COMPOSIO_DENIED_TOOLKITS = new Set([
  "gmail",
  "outlook",
  "outlook_calendar",
  "microsoft_outlook",
  "sendgrid",
  "mailchimp",
  "resend",
  "smtp",
  "email",
  "postmark",
  "mailgun",
  "ses",
  "amazon_ses",
]);

const CONNECT_WAIT_MS = 10 * 60 * 1000;

type SessionHandle = Awaited<ReturnType<Composio["create"]>>;

let client: Composio | null = null;
/** Sessions keyed by Composio userId (skill-scoped). */
const sessions = new Map<string, Promise<SessionHandle>>();
/** Pending bindings during forge/test before decision.json exists. */
const pendingBindings = new Map<string, ComposioSkillBinding>();

/** Slug segment shared by userId and pending Map keys (display name ↔ folder name). */
export function bindingKey(skillName: string): string {
  return (
    skillName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "forged_skill"
  );
}

export function skillComposioUserId(skillName: string): string {
  return `nightborn:skill:${bindingKey(skillName)}`;
}

export function isComposioConfigured(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY?.trim()) && process.env.OFFLINE !== "1";
}

export function normalizeToolkit(slug: string): string {
  return slug.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

export function setPendingComposioBinding(
  skillName: string,
  binding: ComposioSkillBinding,
): void {
  pendingBindings.set(bindingKey(skillName), binding);
}

export function getPendingComposioBinding(
  skillName: string,
): ComposioSkillBinding | null {
  return pendingBindings.get(bindingKey(skillName)) ?? null;
}

export function clearPendingComposioBinding(skillName: string): void {
  pendingBindings.delete(bindingKey(skillName));
}

export function loadSkillComposioBinding(skillName: string): ComposioSkillBinding | null {
  const pending = pendingBindings.get(bindingKey(skillName));
  if (pending) return pending;
  // decision.json lives under the on-disk folder name (already a slug).
  const p = path.join(dataPath("skills"), skillName, "decision.json");
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as DecisionJson;
    if (d.composio?.toolkit && d.composio?.userId) return d.composio;
  } catch {
    /* ignore */
  }
  return null;
}

function composioLog(
  decision: "allow" | "deny" | "pass" | "fail",
  detail: string,
  skill: string | null = null,
): void {
  let charterHash = "unpinned";
  try {
    charterHash = getCharterHash();
  } catch {
    /* host not booted yet — still log */
  }
  appendLog({
    actor: "forge",
    event: "forge",
    skill,
    decision,
    charterHash,
    detail: `composio · ${detail}`.slice(0, 1200),
  });
}

function getClient(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) throw new Error("COMPOSIO_API_KEY missing");
  if (!client) {
    client = new Composio({ apiKey, allowTracking: false });
  }
  return client;
}

async function getSessionForUserId(userId: string): Promise<SessionHandle> {
  let p = sessions.get(userId);
  if (!p) {
    p = (async () => {
      const composio = getClient();
      return composio.create(userId, {
        toolkits: [...COMPOSIO_ALLOWED_TOOLKITS],
        manageConnections: true,
      });
    })().catch((err) => {
      sessions.delete(userId);
      throw err;
    });
    sessions.set(userId, p);
  }
  return p;
}

async function getSkillSession(skillName: string): Promise<SessionHandle> {
  return getSessionForUserId(skillComposioUserId(skillName));
}

/** Reset cached client/sessions (tests / after env reload). */
export function resetComposioClient(): void {
  client = null;
  sessions.clear();
}

export type AccessRequestOk = {
  ok: true;
  requestId: string;
  toolkit: string;
  skillName: string;
  userId: string;
  redirectUrl: string | null;
  alreadyConnected: boolean;
};

export type AccessRequestErr = {
  ok: false;
  code: "missing_api_key" | "offline" | "denied" | "not_allowed" | "error";
  message: string;
  requestId: string;
  toolkit: string;
  skillName: string;
};

export type AccessRequestResult = AccessRequestOk | AccessRequestErr;

export function newAccessRequestId(toolkit: string): string {
  const stamp = Date.now().toString(36);
  const rnd = randomBytes(3).toString("hex");
  return `acc_${toolkit}_${stamp}_${rnd}`.slice(0, 80);
}

function policyCheck(
  toolkit: string,
  requestId: string,
  skillName: string,
  why: string,
): AccessRequestErr | null {
  if (!toolkit) {
    return {
      ok: false,
      code: "error",
      message: "toolkit slug required",
      requestId,
      toolkit: "",
      skillName,
    };
  }
  if (COMPOSIO_DENIED_TOOLKITS.has(toolkit) || /mail|smtp|email/.test(toolkit)) {
    composioLog("deny", `denied toolkit=${toolkit} · ${why.slice(0, 80)}`, skillName);
    return {
      ok: false,
      code: "denied",
      message: `Composio toolkit "${toolkit}" is denied (email/SMTP paths stay on the DENIED specimen).`,
      requestId,
      toolkit,
      skillName,
    };
  }
  if (!COMPOSIO_ALLOWED_TOOLKITS.has(toolkit)) {
    composioLog("deny", `not_allowed toolkit=${toolkit}`, skillName);
    return {
      ok: false,
      code: "not_allowed",
      message: `Composio toolkit "${toolkit}" is not on the host allow-list (allowed: ${[...COMPOSIO_ALLOWED_TOOLKITS].join(", ")}).`,
      requestId,
      toolkit,
      skillName,
    };
  }
  if (process.env.OFFLINE === "1") {
    return {
      ok: false,
      code: "offline",
      message: "Composio is unavailable while OFFLINE=1.",
      requestId,
      toolkit,
      skillName,
    };
  }
  if (!process.env.COMPOSIO_API_KEY?.trim()) {
    return {
      ok: false,
      code: "missing_api_key",
      message: "COMPOSIO_API_KEY missing — add it to .env and restart (or reload secrets).",
      requestId,
      toolkit,
      skillName,
    };
  }
  return null;
}

async function toolkitAlreadyConnected(
  session: SessionHandle,
  toolkit: string,
): Promise<boolean> {
  try {
    const listed = await session.toolkits({ toolkits: [toolkit] });
    const item = listed.items.find((t) => t.slug.toLowerCase() === toolkit);
    if (!item) return false;
    if (item.isNoAuth) return true;
    return Boolean(item.connection?.isActive);
  } catch {
    return false;
  }
}

export async function isSkillToolkitConnected(
  skillName: string,
  toolkit: string,
): Promise<boolean> {
  if (!isComposioConfigured()) return false;
  const tk = normalizeToolkit(toolkit);
  if (!COMPOSIO_ALLOWED_TOOLKITS.has(tk)) return false;
  try {
    const session = await getSkillSession(skillName);
    return toolkitAlreadyConnected(session, tk);
  } catch {
    return false;
  }
}

/**
 * Start Connect Link for an allow-listed toolkit on a skill-scoped session.
 */
export async function requestToolkitAccess(opts: {
  toolkit: string;
  requestId?: string;
  goalId: string;
  skillName: string;
  why: string;
}): Promise<AccessRequestResult> {
  const toolkit = normalizeToolkit(opts.toolkit);
  const skillName = opts.skillName.trim() || "forged_skill";
  const requestId = opts.requestId?.trim() || newAccessRequestId(toolkit || "toolkit");
  const userId = skillComposioUserId(skillName);

  const denied = policyCheck(toolkit, requestId, skillName, opts.why);
  if (denied) return denied;

  try {
    const session = await getSkillSession(skillName);
    if (await toolkitAlreadyConnected(session, toolkit)) {
      const binding = { toolkit, userId };
      setPendingComposioBinding(skillName, binding);
      composioLog(
        "pass",
        `already connected toolkit=${toolkit} skill=${skillName} requestId=${requestId}`,
        skillName,
      );
      // Do not emit access.ready — nothing was waiting on Connect Link.
      // Emitting mid-forge steals the WIP brief via Doctor's retry bridge.
      return {
        ok: true,
        requestId,
        toolkit,
        skillName,
        userId,
        redirectUrl: null,
        alreadyConnected: true,
      };
    }

    const connectionRequest = await session.authorize(toolkit);
    const redirectUrl = connectionRequest.redirectUrl ?? null;
    setPendingComposioBinding(skillName, { toolkit, userId });
    composioLog(
      "allow",
      `needs_connect toolkit=${toolkit} skill=${skillName} requestId=${requestId} url=${redirectUrl ?? "(none)"}`,
      skillName,
    );

    await emit({
      type: "access.needs_connect",
      requestId,
      goalId: opts.goalId,
      toolkit,
      redirectUrl: redirectUrl ?? "",
      message: redirectUrl
        ? `Connect ${toolkit} for skill ${skillName}: ${redirectUrl}`
        : `Connect ${toolkit} for skill ${skillName} (no redirect URL — check Composio dashboard).`,
    });

    void pollConnection(connectionRequest, {
      requestId,
      goalId: opts.goalId,
      toolkit,
      skillName,
      userId,
    });

    return {
      ok: true,
      requestId,
      toolkit,
      skillName,
      userId,
      redirectUrl,
      alreadyConnected: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    composioLog("fail", `authorize error toolkit=${toolkit}: ${message}`, skillName);
    return {
      ok: false,
      code: "error",
      message: `Composio authorize failed: ${message}`,
      requestId,
      toolkit,
      skillName,
    };
  }
}

function pollConnection(
  connectionRequest: { waitForConnection: (timeout?: number) => Promise<unknown> },
  meta: {
    requestId: string;
    goalId: string;
    toolkit: string;
    skillName: string;
    userId: string;
  },
): void {
  void connectionRequest
    .waitForConnection(CONNECT_WAIT_MS)
    .then(async () => {
      setPendingComposioBinding(meta.skillName, {
        toolkit: meta.toolkit,
        userId: meta.userId,
      });
      composioLog(
        "pass",
        `access.ready toolkit=${meta.toolkit} skill=${meta.skillName} requestId=${meta.requestId}`,
        meta.skillName,
      );
      await emit({
        type: "access.ready",
        requestId: meta.requestId,
        goalId: meta.goalId,
        toolkit: meta.toolkit,
      });
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      composioLog(
        "fail",
        `access.failed toolkit=${meta.toolkit} skill=${meta.skillName}: ${message}`,
        meta.skillName,
      );
      await emit({
        type: "access.failed",
        requestId: meta.requestId,
        goalId: meta.goalId,
        toolkit: meta.toolkit,
        error: message,
      });
    });
}

export type ComposioExecuteResult =
  | { ok: true; tool: string; data: Record<string, unknown>; logId: string }
  | { ok: false; tool: string; error: string };

function toolPolicy(slug: string): string | null {
  if (!slug) return "tool slug required";
  const toolkitGuess = slug.split("_")[0]?.toLowerCase() ?? "";
  if (
    COMPOSIO_DENIED_TOOLKITS.has(toolkitGuess) ||
    /mail|smtp|email/.test(toolkitGuess) ||
    /mail|smtp|email/.test(slug.toLowerCase())
  ) {
    return `Composio tool "${slug}" denied (email/SMTP paths blocked)`;
  }
  if (toolkitGuess && !COMPOSIO_ALLOWED_TOOLKITS.has(toolkitGuess)) {
    return `Composio tool "${slug}" not on allow-list (toolkit "${toolkitGuess}")`;
  }
  return null;
}

/**
 * Execute a Composio tool in a skill-scoped session.
 */
export async function executeComposioTool(
  tool: string,
  args: Record<string, unknown> = {},
  skillName?: string,
): Promise<ComposioExecuteResult> {
  const slug = tool.trim();
  const policyErr = toolPolicy(slug);
  if (policyErr) return { ok: false, tool: slug, error: policyErr };

  if (process.env.OFFLINE === "1") {
    return { ok: false, tool: slug, error: "Composio unavailable while OFFLINE=1" };
  }
  if (!process.env.COMPOSIO_API_KEY?.trim()) {
    return {
      ok: false,
      tool: slug,
      error: "COMPOSIO_API_KEY missing — add it to .env and restart",
    };
  }

  const skill = skillName?.trim() || "nightborn";
  const toolkitGuess = slug.split("_")[0]?.toLowerCase() ?? "";

  try {
    const session = skillName?.trim()
      ? await getSkillSession(skill)
      : await getSessionForUserId(process.env.COMPOSIO_USER_ID?.trim() || "nightborn");
    const result = await session.execute(slug, args);
    if (result.error) {
      composioLog("fail", `execute ${slug}: ${result.error}`, skill);
      return { ok: false, tool: slug, error: result.error };
    }
    composioLog("pass", `execute ${slug} logId=${result.logId}`, skill);
    return { ok: true, tool: slug, data: result.data, logId: result.logId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    composioLog("fail", `execute ${slug}: ${message}`, toolkitGuess || skill);
    return { ok: false, tool: slug, error: message };
  }
}

/**
 * Skill-bound proxy execute: only tools matching the skill's bound toolkit.
 */
export async function executeForSkill(
  skillName: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<ComposioExecuteResult> {
  const binding = loadSkillComposioBinding(skillName);
  if (!binding) {
    return {
      ok: false,
      tool: tool.trim(),
      error: `No Composio binding for skill ${skillName}`,
    };
  }
  const slug = tool.trim();
  const toolkitGuess = slug.split("_")[0]?.toLowerCase() ?? "";
  if (toolkitGuess && toolkitGuess !== binding.toolkit) {
    return {
      ok: false,
      tool: slug,
      error: `Tool "${slug}" not in bound toolkit ${binding.toolkit}`,
    };
  }
  return executeComposioTool(slug, args, skillName);
}

export async function searchComposioTools(
  skillName: string,
  query: string,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (!isComposioConfigured()) {
    return { ok: false, error: "Composio not configured" };
  }
  try {
    const session = await getSkillSession(skillName);
    const binding = loadSkillComposioBinding(skillName);
    const result = await session.search({
      query,
      ...(binding ? { toolkits: [binding.toolkit] } : { toolkits: [...COMPOSIO_ALLOWED_TOOLKITS] }),
    });
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Loopback URL skills use to execute Composio via the host. */
export function composioProxyUrlForSkill(skillName: string): string {
  const port = process.env.PORT ?? "8787";
  const safe = encodeURIComponent(skillName);
  return `http://127.0.0.1:${port}/api/composio/skill/${safe}/execute`;
}
