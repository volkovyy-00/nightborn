import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { REPO_ROOT, repoPath } from "./paths.ts";
import { loadAndPinCharter, getCharterHash } from "./charter.ts";
import { appendLog, ensureLogFile, getLogSince, resolveLogSource } from "./log.ts";
import { list as listAudit } from "./audit.ts";
import {
  getMessagesSince,
  rehydrateTranscript,
  subscribe,
  type TranscriptMessage,
} from "./transcript.ts";
import { executeForSkill } from "./composio.ts";
import { startComposioDoctorRetryBridge } from "./doctor/index.ts";
import { handleTalk, startAgentRuntime } from "./runner.ts";
import { mockProviderResponse } from "./mock.ts";
import {
  DEFAULT_NOTE,
  getLearnedVoiceId,
  learnVoiceFromSample,
  synthesizeNote,
  voiceStatus,
} from "./eleven.ts";
import { startScheduler } from "./schedule.ts";

// Load .env from repo root (not cwd)
const envFile = path.join(REPO_ROOT, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

ensureLogFile();
rehydrateTranscript();

{
  const hostChannel = resolveLogSource();
  if (hostChannel !== "live") {
    const file =
      hostChannel === "fixture"
        ? "surgery.fixture.log"
        : hostChannel === "smoke"
          ? "surgery.smoke.log"
          : `surgery.${hostChannel}.log`;
    console.warn(
      `[nightborn] hostChannel=${hostChannel} — writing ${file}; UI polls surgery.log (live). ` +
        `Unset JUDGE_MODE / SMOKE_AGENT / SURGERY_CHANNEL for the live board.`,
    );
  }
}

try {
  const hash = loadAndPinCharter();
  appendLog({
    actor: "warden",
    event: "boot",
    skill: null,
    decision: "allow",
    charterHash: hash,
    detail: `pin ✓ · channel=${resolveLogSource()}`,
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

// Agent runtime: event bridge + resume-on-capability.ready (no user re-prompt).
// Scheduler: once/cron wakes (T11); call site owned by T09.
startAgentRuntime();
startScheduler();
startComposioDoctorRetryBridge();

const app = new Hono();

/**
 * Skill-scoped Composio proxy — skills POST { tool, arguments } here.
 * Host holds COMPOSIO_API_KEY; binding must match decision.json / pending forge.
 */
app.post("/api/composio/skill/:name/execute", async (c) => {
  const skillName = decodeURIComponent(c.req.param("name") || "").trim();
  if (!skillName || !/^[a-z0-9_]+$/i.test(skillName)) {
    return c.json({ ok: false, error: "invalid skill name" }, 400);
  }
  let body: { tool?: string; arguments?: Record<string, unknown> };
  try {
    body = (await c.req.json()) as { tool?: string; arguments?: Record<string, unknown> };
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const tool = typeof body.tool === "string" ? body.tool.trim() : "";
  if (!tool) return c.json({ ok: false, error: "tool required" }, 400);
  const args =
    body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
      ? body.arguments
      : {};
  const result = await executeForSkill(skillName, tool, args);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error, tool: result.tool }, 400);
  }
  return c.json({
    ok: true,
    tool: result.tool,
    data: result.data,
    logId: result.logId,
  });
});

app.get("/api/log", (c) => {
  const since = Number(c.req.query("since") ?? "0");
  // UI always reads live surgery.log; smoke/fixture write separate files.
  const raw = (c.req.query("source") || "live").toLowerCase();
  const source =
    raw === "smoke" || raw === "fixture" || raw === "live" ? raw : "live";
  return c.json(getLogSince(Number.isFinite(since) ? since : 0, source));
});

/** Goal-centric audit trail (T01 sink). Optional ?goalId= / ?since= filters. */
app.get("/api/audit", async (c) => {
  const goalId = c.req.query("goalId") || undefined;
  const since = c.req.query("since") || undefined;
  const records = await listAudit({
    ...(goalId ? { goalId } : {}),
    ...(since ? { since } : {}),
  });
  return c.json({ records });
});

/** Catch-up JSON for debug / late EventSource (id > since). */
app.get("/api/messages", (c) => {
  const since = Number(c.req.query("since") ?? "0");
  const goalId = c.req.query("goalId") || undefined;
  return c.json(
    getMessagesSince(Number.isFinite(since) ? since : 0, goalId),
  );
});

/**
 * Live chat stream — text/event-stream.
 * Replays id > Last-Event-ID (or ?since=), then pushes each appendMessage.
 */
app.get("/api/messages/stream", (c) => {
  const goalId = c.req.query("goalId") || undefined;
  const lastEventId = c.req.header("Last-Event-ID");
  const sinceQ = c.req.query("since");
  const { next: tip } = getMessagesSince(0, goalId);
  // Fresh connect: live-only. Reconnect / ?since= catch up.
  let since = tip;
  if (lastEventId != null && lastEventId !== "") {
    const n = Number(lastEventId);
    if (Number.isFinite(n)) since = n;
  } else if (sinceQ != null && sinceQ !== "") {
    const n = Number(sinceQ);
    if (Number.isFinite(n)) since = n;
  }

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsub: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (msg: TranscriptMessage) => {
        if (closed) return;
        if (goalId && msg.goalId !== goalId) return;
        const chunk =
          `id: ${msg.id}\n` +
          `event: message\n` +
          `data: ${JSON.stringify(msg)}\n\n`;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
      } catch {
        cleanup();
        return;
      }

      const { messages } = getMessagesSince(since, goalId);
      for (const m of messages) send(m);

      unsub = subscribe(send);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          cleanup();
        }
      }, 15_000);

      function cleanup() {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsub?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      c.req.raw.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsub?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

/** @deprecated alias — maps transcript catch-up to old notices shape. */
app.get("/api/notices", (c) => {
  const since = Number(c.req.query("since") ?? "0");
  const { messages, next } = getMessagesSince(
    Number.isFinite(since) ? since : 0,
  );
  return c.json({
    notices: messages.map((m) => ({
      id: m.id,
      ts: m.ts,
      kind: m.role === "status" ? "status" : "reply",
      text: m.text,
      skill: m.skill ?? null,
      goalId: m.goalId,
    })),
    next,
  });
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
