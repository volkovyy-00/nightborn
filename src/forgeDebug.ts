/**
 * Durable Forge debug dumps — prompt, stdout, Pi tools — outside wiped skill staging.
 * Default on; opt out with FORGE_DEBUG=0|false|off.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { briefFileStem } from "./doctor/inbox.ts";
import { getCharterHash } from "./charter.ts";
import { appendLog } from "./log.ts";
import { dataPath } from "./paths.ts";
import type { ForgeContext } from "./types.ts";

export type ForgeDebugBackend = "cursor" | "pi" | "cursor-sdk" | "scaffold" | "fixture";

export type ForgeDebugSession = {
  dir: string;
  relPath: string;
  backend: ForgeDebugBackend;
  skillName: string;
};

export function forgeDebugEnabled(): boolean {
  const v = (process.env.FORGE_DEBUG ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

function clip(s: string, n = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function surgeryForge(
  skill: string | null,
  detail: string,
  decision: "allow" | "fail" = "allow",
): void {
  try {
    appendLog({
      actor: "forge",
      event: "forge",
      skill,
      decision,
      charterHash: getCharterHash(),
      detail,
    });
  } catch {
    /* charter not pinned yet in some unit tests */
  }
}

/** Prompt prefix so Forge treats the original user message as authoritative. */
export function forgeAuthoritativeAskPrefix(
  ctx?: Pick<ForgeContext, "userAsk"> | null,
): string {
  const ask = ctx?.userAsk?.trim();
  if (!ask) return "";
  return (
    `USER ASK (authoritative): ${JSON.stringify(ask)}\n` +
    `Forge for the USER ASK. Do not substitute cars.com unless the user named it.\n`
  );
}

export function createForgeDebugSession(
  ctx: Pick<
    ForgeContext,
    "skillName" | "requestId" | "goalId" | "userAsk" | "defaultsHint" | "siteHost" | "minimalSuccess"
  >,
  runId: string,
  backend: ForgeDebugBackend,
): ForgeDebugSession | null {
  if (!forgeDebugEnabled()) return null;
  const stem = briefFileStem(ctx.requestId || "forge");
  const folder = `${stem}_${runId}`;
  const relPath = path.join("staging", "forge_debug", folder);
  const dir = dataPath("staging", "forge_debug", folder);
  mkdirSync(dir, { recursive: true });
  const meta = {
    backend,
    skillName: ctx.skillName,
    requestId: ctx.requestId,
    goalId: ctx.goalId,
    userAsk: ctx.userAsk ?? null,
    defaultsHint: ctx.defaultsHint ?? null,
    siteHost: ctx.siteHost ?? null,
    minimalSuccess: ctx.minimalSuccess ?? null,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  const session: ForgeDebugSession = {
    dir,
    relPath: relPath.replace(/\\/g, "/"),
    backend,
    skillName: ctx.skillName,
  };
  surgeryForge(
    ctx.skillName,
    `forge debug · writing ${session.relPath}/ · backend=${backend}`,
  );
  return session;
}

/** Ensure ctx.debugDir points at a session dir; create one if missing. */
export function ensureForgeDebugDir(
  ctx: ForgeContext | null | undefined,
  backend: ForgeDebugBackend,
): ForgeDebugSession | null {
  if (!forgeDebugEnabled() || !ctx) return null;
  if (ctx.debugDir) {
    return {
      dir: ctx.debugDir,
      relPath: path.relative(dataPath(), ctx.debugDir).replace(/\\/g, "/") || ctx.debugDir,
      backend,
      skillName: ctx.skillName,
    };
  }
  const runId = `auto_${Date.now().toString(36)}`;
  const session = createForgeDebugSession(ctx, runId, backend);
  if (session) ctx.debugDir = session.dir;
  return session;
}

export function writeForgeDebug(
  session: ForgeDebugSession | null | undefined,
  name: string,
  content: string | object,
): void {
  if (!session) return;
  const body =
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
  writeFileSync(path.join(session.dir, name), body, "utf8");
}

export function appendForgeToolLine(
  session: ForgeDebugSession | null | undefined,
  event: {
    phase: "start" | "end";
    toolName: string;
    argsSummary?: string;
    ok?: boolean;
    detail?: string;
  },
): void {
  if (!session) return;
  const line = {
    ts: new Date().toISOString(),
    ...event,
  };
  appendFileSync(path.join(session.dir, "tools.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
  if (event.phase === "start" || event.toolName === "emit_forge_skill") {
    surgeryForge(
      session.skillName,
      `forge tool · ${event.phase} · ${event.toolName}` +
        (event.argsSummary ? ` · ${clip(event.argsSummary, 120)}` : ""),
    );
  }
}

export function finishForgeDebug(
  session: ForgeDebugSession | null | undefined,
  opts?: { promptBytes?: number; stdoutBytes?: number; error?: string },
): void {
  if (!session) return;
  if (opts?.error) {
    writeForgeDebug(session, "error.txt", opts.error);
  }
  const bits = [
    `forge debug · done · path=${session.relPath}`,
    opts?.promptBytes != null ? `prompt=${opts.promptBytes}` : "",
    opts?.stdoutBytes != null ? `stdout=${opts.stdoutBytes}` : "",
    opts?.error ? `error=${clip(opts.error, 100)}` : "",
  ].filter(Boolean);
  surgeryForge(session.skillName, bits.join(" · "), opts?.error ? "fail" : "allow");
}

export function sessionFromCtx(
  ctx: ForgeContext | null | undefined,
  backend: ForgeDebugBackend,
): ForgeDebugSession | null {
  return ensureForgeDebugDir(ctx ?? undefined, backend);
}
