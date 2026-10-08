import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { REPO_ROOT, repoPath } from "./paths.ts";
import { loadAndPinCharter, getCharterHash } from "./charter.ts";
import { appendLog, ensureLogFile, getLogSince } from "./log.ts";
import { handleTalk } from "./runner.ts";
import { mockResponse } from "./mock.ts";
import { chatReply } from "./replies.ts";

// Load .env from repo root (not cwd)
const envFile = path.join(REPO_ROOT, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

ensureLogFile();

try {
  const hash = loadAndPinCharter();
  appendLog({
    actor: "warden",
    event: "boot",
    skill: null,
    decision: "allow",
    charterHash: hash,
    detail: "pin ✓",
  });
} catch (e) {
  const err = e as Error & { computed?: string };
  const computed = err.computed ?? "unknown";
  try {
    appendLog({
      actor: "warden",
      event: "boot",
      skill: null,
      decision: "deny",
      failureCode: "charter_pin_mismatch",
      charterHash: computed,
      detail: "charter_pin_mismatch",
    });
  } catch {
    /* log may fail */
  }
  console.error("charter_pin_mismatch", computed);
  process.exit(1);
}

const app = new Hono();

app.get("/api/log", (c) => {
  const since = Number(c.req.query("since") ?? "0");
  return c.json(getLogSince(Number.isFinite(since) ? since : 0));
});

app.post("/api/talk", async (c) => {
  let text = "";
  let fixture: string | undefined;
  try {
    const body = (await c.req.json()) as { text?: unknown; fixture?: unknown };
    text = String(body.text ?? "");
    fixture = typeof body.fixture === "string" ? body.fixture : undefined;
  } catch {
    /* empty body → empty text */
  }
  try {
    return c.json(await handleTalk(text, fixture));
  } catch (e) {
    console.error("POST /api/talk failed:", e); // server console only; never in the reply or log
    return c.json({ kind: "chat", text: chatReply("talk_failed") }, 500);
  }
});

// OFFLINE: skills request `new URL(u.host + u.pathname + u.search, baseUrl)` → /mock/<host>/<path>?<query>
if (process.env.OFFLINE === "1") {
  app.get("/mock/:host/*", (c) => {
    const host = c.req.param("host");
    const url = new URL(c.req.url);
    const pathname = url.pathname.slice(`/mock/${host}`.length);
    const body = mockResponse(host, pathname, url.searchParams);
    return body === null ? c.json({ error: "no fixture" }, 404) : c.json(body);
  });
}

app.use("/*", serveStatic({ root: repoPath("public") }));

const port = Number(process.env.PORT ?? "8787");
console.log(`Nightborn listening on http://127.0.0.1:${port} · charter ${getCharterHash().slice(0, 8)}`);
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
// POST /api/talk may take ≤300 s (forge); SPEC §9 "Timeouts": server requestTimeout 310 s.
(server as unknown as { requestTimeout: number }).requestTimeout = 310_000;
