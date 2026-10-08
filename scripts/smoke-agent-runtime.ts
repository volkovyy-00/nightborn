/**
 * T14 — Used-car path smoke (OFFLINE-friendly).
 *
 * explore → request scrapers → park/wait → Doctor capability.ready → resume
 * → (optional) call capability needs_secret → .env reload/retry → ready
 *
 * Run: OFFLINE=1 npx tsx scripts/smoke-agent-runtime.ts
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { list as listAudit, type AuditRecord } from "../src/audit.ts";
import {
  executeActions,
  runAgentLoop,
  wireAgentResume,
  type PlanFn,
} from "../src/agent/loop.ts";
import { loadParkedGoal } from "../src/agent/park.ts";
import type { AgentAction, CapabilityBrief } from "../src/agent/types.ts";
import { loadAndPinCharter } from "../src/charter.ts";
import { doctorDirs } from "../src/doctor/inbox.ts";
import { subscribe, type RuntimeEvent } from "../src/events.ts";
import { ensureLogFile } from "../src/log.ts";
import { mockProviderResponse } from "../src/mock.ts";
import { REPO_ROOT, repoPath } from "../src/paths.ts";
import { executeJob } from "../src/runner.ts";
import {
  reloadEnvFromDotfile,
  retryParkedSecretBriefs,
} from "../src/secrets.ts";
import type { Job, TalkResult } from "../src/types.ts";

const FIXTURE = repoPath("fixtures", "agent", "used-car-path.json");
const SKIP_CALL = process.env.SMOKE_SKIP_CALL === "1";
const READY_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);

type SiteFx = {
  key: string;
  title: string;
  url: string;
  skillTitle: string;
  defaultsHint: string;
};

type Fixture = {
  goalText: string;
  exploreQuery: string;
  scrapeQuery: string;
  callQuery: string;
  sites: SiteFx[];
  call: {
    skillTitle: string;
    defaultsHint: string;
    suggestedCaps: string[];
    why: string;
  };
  exploreItems: { title: string; url: string }[];
};

type Check = { name: string; ok: boolean; detail: string };

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
}

function loadDotEnv(): void {
  const envFile = path.join(REPO_ROOT, ".env");
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function startMockServer(port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const m = u.pathname.match(/^\/mock\/([^/]+)(?:\/v1\/calls)?\/?$/);
      if (!m) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const provider = m[1]!;
      let q = u.searchParams.get("q") ?? u.searchParams.get("query") ?? "listings";
      if (req.method === "POST") {
        const raw = await readBody(req);
        try {
          const body = JSON.parse(raw || "{}") as {
            query?: string;
            phone_number?: string;
            task?: string;
          };
          if (body.query) q = body.query;
          else if (body.phone_number) q = `${body.phone_number}|||${body.task ?? ""}`;
        } catch {
          /* keep q */
        }
      }
      const payload = mockProviderResponse(provider, q);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  return server;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = addr;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

function briefForSite(
  site: SiteFx,
  goalId: string,
  requestId: string,
  auditRef: string,
): CapabilityBrief {
  return {
    requestId,
    goalId,
    auditRef,
    title: site.skillTitle,
    intent: `Scrape used-car listing cards from ${site.title}`,
    minimalSuccess: `Given { "query": "BMW under 10k" }, return { "items": [{ "title", "url", "date?" }] } with ≥1 item.`,
    suggestedCaps: ["net:fetch"],
    defaultsHint: site.defaultsHint,
    why: `Exploration listed ${site.title} (${site.url}); need structured cards to rank deals.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(
  label: string,
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
}

function fileExists(p: string): boolean {
  return existsSync(p);
}

async function main(): Promise<void> {
  loadDotEnv();
  process.env.OFFLINE = "1";
  // Avoid Pi planner / live forge — Doctor uses defaults scaffolds.
  process.env.JUDGE_MODE = process.env.JUDGE_MODE || "1";

  const fx = loadFixture();
  const stamp = Date.now().toString(36);
  const goalId = `goal_smoke_cars_${stamp}`;
  const scrapeIds = fx.sites.map((s) => `req_smoke_scrape_${s.key}_${stamp}`);
  const callId = `req_smoke_call_${stamp}`;

  const port = await pickFreePort();
  process.env.PORT = String(port);
  const mock = await startMockServer(port);

  ensureLogFile();
  loadAndPinCharter();

  const events: RuntimeEvent[] = [];
  const unsubEvents = subscribe((e) => {
    events.push(e);
  });

  const resumes: { goalId: string; requestId: string; skill: string; allSatisfied: boolean }[] =
    [];
  let plannedUserTurn = false;

  const plan: PlanFn = async (ctx) => {
    if (ctx.event?.type === "capability.ready") {
      const needs = ctx.event.skill.includes("call")
        ? ["notify:phone", "net:fetch"]
        : ["net:fetch"];
      const query = ctx.event.skill.includes("call") ? fx.callQuery : fx.scrapeQuery;
      return [
        {
          type: "run_skill",
          skill: ctx.event.skill,
          intent: `Use newly ready skill ${ctx.event.skill}`,
          query,
          needs,
        },
        {
          type: "chat",
          text: `Capability ready — ran ${ctx.event.skill}.`,
        },
      ];
    }

    if (ctx.userText && !plannedUserTurn) {
      plannedUserTurn = true;
      const actions: AgentAction[] = [
        {
          type: "run_skill",
          skill: "explore_listings_stub",
          intent: "explore where used cars are listed",
          query: fx.exploreQuery,
          needs: ["net:fetch"],
        },
        {
          type: "write_memory",
          path: `goals/${goalId}.md`,
          markdown: [
            `# Goal: best used-car deals`,
            "",
            `Status: waiting_on_capabilities`,
            `Constraints: prefer local listings; verify by phone when numbers exist`,
            `Sites: ${fx.sites.map((s) => s.title).join(", ")}`,
            "",
          ].join("\n"),
        },
      ];
      for (let i = 0; i < fx.sites.length; i++) {
        const site = fx.sites[i]!;
        const brief = briefForSite(site, goalId, scrapeIds[i]!, `aud_smoke_${site.key}_${stamp}`);
        actions.push({ type: "request_capability", brief });
      }
      actions.push({
        type: "wait",
        reason: "scrapers for listing sites",
        requestIds: [...scrapeIds],
      });
      actions.push({
        type: "chat",
        text: "Parked on scrapers for Site A/B — Doctor forging.",
      });
      return actions;
    }

    return [];
  };

  const runSkill = async (job: Job): Promise<TalkResult> => {
    if (job.skill === "explore_listings_stub" || /explore/i.test(job.intent)) {
      return {
        kind: "job",
        job,
        outcome: "ok",
        skill: "explore_listings_stub",
        reply: JSON.stringify({ items: fx.exploreItems }, null, 2),
      };
    }
    return executeJob({ ...job, skill: job.skill }, undefined, "fixture");
  };

  const stopResume = wireAgentResume({
    plan,
    runSkill,
    onResult(_result, resume) {
      resumes.push({
        goalId: resume.goalId,
        requestId: resume.requestId,
        skill: resume.skill,
        allSatisfied: resume.allSatisfied,
      });
    },
  });

  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    const dirs = doctorDirs();

    const loop = await runAgentLoop({ goalId, userText: fx.goalText }, { plan, runSkill });
    push(
      "agent_parked",
      loop.status === "waiting",
      `status=${loop.status} text=${loop.text.slice(0, 80)}`,
    );

    const parked = await loadParkedGoal(goalId);
    push(
      "wait_state",
      !!parked &&
        parked.status === "waiting_on_capabilities" &&
        scrapeIds.every((id) => parked.requestIds.includes(id)),
      parked ? `requestIds=${parked.requestIds.join(",")}` : "missing park file",
    );

    // Briefs were written to inbox (may already have moved to wip/done).
    const briefSeen = scrapeIds.every((id) => {
      const name = `${id}.md`;
      return (
        fileExists(path.join(dirs.inbox, name)) ||
        fileExists(path.join(dirs.wip, name)) ||
        fileExists(path.join(dirs.done, name))
      );
    });
    push("inbox_briefs_written", briefSeen, scrapeIds.join(", "));

    await waitUntil(
      "scraper capability.ready",
      () =>
        scrapeIds.every((id) =>
          events.some((e) => e.type === "capability.ready" && e.requestId === id),
        ),
      READY_TIMEOUT_MS,
    );

    const readyScrapes = events.filter(
      (e): e is Extract<RuntimeEvent, { type: "capability.ready" }> =>
        e.type === "capability.ready" && scrapeIds.includes(e.requestId),
    );
    push(
      "capability_ready_scrapers",
      readyScrapes.length >= scrapeIds.length,
      readyScrapes.map((e) => `${e.requestId}→${e.skill}`).join("; "),
    );

    await waitUntil(
      "agent resume",
      () => resumes.filter((r) => r.goalId === goalId).length >= scrapeIds.length,
      READY_TIMEOUT_MS,
    );
    push(
      "agent_resume",
      resumes.some((r) => r.goalId === goalId && r.allSatisfied),
      `resumes=${resumes.length} lastSatisfied=${resumes[resumes.length - 1]?.allSatisfied}`,
    );

    await waitUntil(
      "park cleared",
      async () => (await loadParkedGoal(goalId)) === null,
      10_000,
    );
    push("park_cleared_after_ready", (await loadParkedGoal(goalId)) === null, "");

    const scrapeDone = scrapeIds.every((id) => fileExists(path.join(dirs.done, `${id}.md`)));
    push("doctor_done_archive", scrapeDone, path.join(dirs.done, `${scrapeIds[0]}.md`));

    const auditSince = new Date(Date.now() - 10 * 60_000).toISOString();
    let auditRows: AuditRecord[] = await listAudit({ goalId, since: auditSince });
    const requested = auditRows.filter((r) => r.type === "capability.requested" && r.why);
    push(
      "audit_why_on_request",
      requested.length >= scrapeIds.length,
      `n=${requested.length} sample=${requested[0]?.why?.slice(0, 60) ?? ""}`,
    );

    if (!SKIP_CALL) {
      const hadBland = Boolean(process.env.BLAND_API_KEY);
      delete process.env.BLAND_API_KEY;

      const callBrief: CapabilityBrief = {
        requestId: callId,
        goalId,
        auditRef: `aud_smoke_call_${stamp}`,
        title: `${fx.call.skillTitle}_${stamp}`,
        intent: "Place outbound verification call for a listing phone",
        minimalSuccess:
          'Given phone|||task, return { "items": [{ "title", "url" }] } confirming call started.',
        suggestedCaps: fx.call.suggestedCaps,
        defaultsHint: fx.call.defaultsHint,
        why: fx.call.why,
      };

      // Re-park for the call capability (same goal).
      const callExec = await executeActions(
        [
          { type: "request_capability", brief: callBrief },
          {
            type: "wait",
            reason: "outbound call capability",
            requestIds: [callId],
          },
        ],
        {
          goalId,
          runSkill,
        },
      );
      push("call_wait_parked", callExec.waiting === true, callExec.waitReason ?? "");

      await waitUntil(
        "capability.needs_secret",
        () =>
          events.some(
            (e) =>
              e.type === "capability.needs_secret" &&
              e.requestId === callId &&
              e.envKeys.includes("BLAND_API_KEY"),
          ),
        READY_TIMEOUT_MS,
      );
      const needs = events.find(
        (e) => e.type === "capability.needs_secret" && e.requestId === callId,
      );
      push(
        "needs_secret_bland",
        !!needs && needs.type === "capability.needs_secret",
        needs && needs.type === "capability.needs_secret" ? needs.message.slice(0, 80) : "",
      );

      // Operator path: reload .env (restores key) or inject offline fake if absent.
      // Preserve smoke PORT/OFFLINE — .env may point elsewhere and would break mock forge.
      const smokePort = process.env.PORT;
      const smokeOffline = process.env.OFFLINE;
      const changed = reloadEnvFromDotfile();
      process.env.PORT = smokePort;
      process.env.OFFLINE = smokeOffline;
      if (!process.env.BLAND_API_KEY) {
        process.env.BLAND_API_KEY = "smoke-offline-fake-bland-key";
      }
      const requeued = await retryParkedSecretBriefs([callId]);
      push(
        "secret_reload_retry",
        requeued.includes(callId) || fileExists(path.join(dirs.inbox, `${callId}.md`)),
        `requeued=${requeued.join(",")} changedKeys=${changed.join(",") || "(none)"} hadBland=${hadBland}`,
      );

      await waitUntil(
        "call capability.ready",
        () => {
          const fail = events.find(
            (e) => e.type === "capability.failed" && e.requestId === callId,
          );
          if (fail && fail.type === "capability.failed") {
            throw new Error(`call capability.failed: ${fail.error}`);
          }
          return events.some((e) => e.type === "capability.ready" && e.requestId === callId);
        },
        READY_TIMEOUT_MS,
      );
      const callReady = events.find((e) => e.type === "capability.ready" && e.requestId === callId);
      push(
        "capability_ready_call",
        !!callReady && callReady.type === "capability.ready",
        callReady && callReady.type === "capability.ready" ? callReady.skill : "",
      );

      auditRows = await listAudit({ goalId, since: auditSince });
      const blocked = auditRows.filter((r) => r.type === "doctor.blocked_on_secret" && r.why);
      push(
        "audit_why_on_secret_block",
        blocked.length >= 1,
        blocked[0]?.why?.slice(0, 80) ?? "",
      );
    } else {
      push("needs_secret_bland", true, "skipped (SMOKE_SKIP_CALL=1)");
      push("capability_ready_call", true, "skipped");
      push("secret_reload_retry", true, "skipped");
      push("audit_why_on_secret_block", true, "skipped");
      push("call_wait_parked", true, "skipped");
    }
  } finally {
    stopResume();
    unsubEvents();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("");
  console.log(`Smoke ${failed.length ? "FAILED" : "OK"} — ${checks.length - failed.length}/${checks.length} checks`);
  if (failed.length) {
    for (const f of failed) console.error(`  • ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("smoke-agent-runtime fatal:", err);
    process.exitCode = 1;
  });
}
