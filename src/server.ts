import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { REPO_ROOT, repoPath } from "./paths.ts";
import { loadAndPinCharter, getCharterHash } from "./charter.ts";
import { appendLog, ensureLogFile, getLogSince } from "./log.ts";
import { handleTalk } from "./runner.ts";
import { mockProviderResponse } from "./mock.ts";

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
  const body = (await c.req.json()) as { text?: string; fixture?: string };
  const text = String(body.text ?? "");
  try {
    const result = await handleTalk(text, body.fixture);
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("POST /api/talk failed:", e);
    return c.json({ kind: "chat", text: `Talk failed: ${msg}` }, 500);
  }
});

if (process.env.OFFLINE === "1") {
  app.get("/mock/:provider", (c) => {
    const provider = c.req.param("provider");
    const q = c.req.query("q") ?? c.req.query("query") ?? "news";
    return c.json(mockProviderResponse(provider, q));
  });
  app.post("/mock/:provider", async (c) => {
    const provider = c.req.param("provider");
    let q = "news";
    try {
      const body = (await c.req.json()) as { query?: string };
      if (body.query) q = body.query;
    } catch {
      /* ignore */
    }
    return c.json(mockProviderResponse(provider, q));
  });
  // Brave-style path
  app.get("/mock/:provider/res/v1/news/search", (c) => {
    const provider = c.req.param("provider");
    const q = c.req.query("q") ?? "news";
    return c.json(mockProviderResponse(provider, q));
  });
}

app.use("/*", serveStatic({ root: repoPath("public") }));

const port = Number(process.env.PORT ?? "8787");
console.log(`Nightborn listening on http://127.0.0.1:${port} · charter ${getCharterHash().slice(0, 8)}`);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
