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
import {
  DEFAULT_NOTE,
  getLearnedVoiceId,
  learnVoiceFromSample,
  synthesizeNote,
  voiceStatus,
} from "./eleven.ts";

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

/** Voice-note demo: status of creature vs learned ElevenLabs voice. */
app.get("/api/voice/status", (c) => c.json(voiceStatus()));

/** TTS a short note as creature (Frankenstein) or learned (your) voice. */
app.post("/api/voice/note", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    which?: "creature" | "learned";
    text?: string;
  };
  const which = body.which === "learned" ? "learned" : "creature";
  const text = (body.text ?? DEFAULT_NOTE).trim() || DEFAULT_NOTE;
  try {
    const { bytes, contentType, voiceId } = await synthesizeNote(which, text);
    appendLog({
      actor: "talk",
      event: "job",
      skill: null,
      decision: "allow",
      charterHash: getCharterHash(),
      detail: `voice_note:${which}:${voiceId.slice(0, 8)}`,
      source: process.env.OFFLINE === "1" ? "fixture" : "live",
    });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentType,
        "X-Nightborn-Voice": which,
        "X-Nightborn-Voice-Id": voiceId,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("POST /api/voice/note failed:", e);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** Instant Voice Clone from an uploaded sample — Frankenstein learns "your" voice. */
app.post("/api/voice/learn", async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get("file") ?? form.get("files");
    if (!file || typeof file === "string") {
      return c.json({ ok: false, error: "multipart field file required" }, 400);
    }
    const f = file as File;
    const data = Buffer.from(await f.arrayBuffer());
    if (data.length < 1000) {
      return c.json({ ok: false, error: "sample too short — speak ~15–30s" }, 400);
    }
    const { voiceId } = await learnVoiceFromSample({
      data,
      filename: f.name || "sample.webm",
      type: f.type || "audio/webm",
    });
    appendLog({
      actor: "forge",
      event: "forge",
      skill: null,
      decision: "allow",
      charterHash: getCharterHash(),
      detail: `voice_learn:${voiceId.slice(0, 8)}`,
      source: process.env.OFFLINE === "1" ? "fixture" : "live",
    });
    return c.json({
      ok: true,
      voiceId,
      learned: true,
      reply: "Voice taken. I can wear it now.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("POST /api/voice/learn failed:", e);
    return c.json({ ok: false, error: msg }, 500);
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
      const body = (await c.req.json()) as {
        query?: string;
        phone_number?: string;
        task?: string;
      };
      if (body.query) q = body.query;
      else if (body.phone_number) q = `${body.phone_number}|||${body.task ?? ""}`;
    } catch {
      /* ignore */
    }
    return c.json(mockProviderResponse(provider, q));
  });
  // Bland Send Call
  app.post("/mock/:provider/v1/calls", async (c) => {
    const provider = c.req.param("provider");
    let q = "outbound";
    try {
      const body = (await c.req.json()) as { phone_number?: string; task?: string };
      if (body.phone_number) q = `${body.phone_number}|||${body.task ?? ""}`;
    } catch {
      /* ignore */
    }
    return c.json(mockProviderResponse(provider, q));
  });
  // Brave-style paths (news + web)
  app.get("/mock/:provider/res/v1/news/search", (c) => {
    const provider = c.req.param("provider");
    const q = c.req.query("q") ?? "news";
    return c.json(mockProviderResponse(provider, q));
  });
  app.get("/mock/:provider/res/v1/web/search", (c) => {
    const provider = c.req.param("provider");
    const q = c.req.query("q") ?? "search";
    return c.json(mockProviderResponse(provider, q));
  });
}

app.use("/*", serveStatic({ root: repoPath("public") }));

const port = Number(process.env.PORT ?? "8787");
console.log(`Nightborn listening on http://127.0.0.1:${port} · charter ${getCharterHash().slice(0, 8)}`);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
