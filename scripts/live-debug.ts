/**
 * Live host debug — Talk + poll surgery.log via the running server.
 *
 *   npx tsx scripts/live-debug.ts "your phrase"
 *   npx tsx scripts/live-debug.ts --wait "Look at used-car listings…"
 *   BASE=http://127.0.0.1:8787 npx tsx scripts/live-debug.ts --tail 30
 *
 * Does not start/stop the host. Writes nothing to surgery.smoke.log.
 */

const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");

type LogLine = {
  ts?: string;
  actor?: string;
  event?: string;
  skill?: string | null;
  decision?: string;
  failureCode?: string;
  detail?: string;
  source?: string;
};

function args(): { text: string | null; wait: boolean; tail: number; since: number } {
  const argv = process.argv.slice(2);
  let wait = false;
  let tail = 20;
  let since = 0;
  const parts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--wait") {
      wait = true;
      continue;
    }
    if (a === "--tail") {
      tail = Number(argv[++i] ?? 20) || 20;
      continue;
    }
    if (a === "--since") {
      since = Number(argv[++i] ?? 0) || 0;
      continue;
    }
    parts.push(a);
  }
  return { text: parts.length ? parts.join(" ") : null, wait, tail, since };
}

async function getLog(since: number): Promise<{ lines: LogLine[]; next: number }> {
  const res = await fetch(`${BASE}/api/log?since=${since}&source=live`);
  if (!res.ok) throw new Error(`GET /api/log ${res.status}`);
  return (await res.json()) as { lines: LogLine[]; next: number };
}

function fmt(l: LogLine): string {
  const det = (l.detail || "").replace(/\s+/g, " ").slice(0, 160);
  return [
    (l.ts || "").slice(11, 19),
    (l.event || "").padEnd(8),
    (l.actor || "").padEnd(7),
    (l.skill || "—").slice(0, 28).padEnd(28),
    (l.failureCode || "").padEnd(16),
    det,
  ].join(" ");
}

async function talk(text: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/api/talk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`POST /api/talk ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function waitDoctor(startNext: number, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  let since = startNext;
  console.log(`\n— waiting for doctor/forge/install (≤${ms}ms) —`);
  while (Date.now() < deadline) {
    const { lines, next } = await getLog(since);
    since = next;
    for (const l of lines) {
      if (
        l.actor === "doctor" ||
        l.event === "doctor" ||
        l.event === "forge" ||
        l.event === "install" ||
        l.failureCode === "doctor_required" ||
        /Doctor|recognized gap/i.test(l.detail || "")
      ) {
        console.log(fmt(l));
      }
      if (l.event === "install" || (l.event === "doctor" && l.decision === "pass" && /ready/i.test(l.detail || ""))) {
        console.log("— install/ready seen —");
        return;
      }
      if (l.event === "broken" || (l.event === "doctor" && l.decision === "fail")) {
        console.log("— doctor/forge failed —");
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log("— wait timed out —");
}

async function main(): Promise<void> {
  const { text, wait, tail, since } = args();

  try {
    await fetch(`${BASE}/api/log?since=0`);
  } catch {
    console.error(`Host not reachable at ${BASE} — start with: npm start`);
    process.exitCode = 1;
    return;
  }

  if (!text) {
    const { lines, next } = await getLog(0);
    console.log(`${BASE} · live log next=${next} · last ${tail} lines\n`);
    for (const l of lines.slice(-tail)) console.log(fmt(l));
    return;
  }

  const before = await getLog(since);
  console.log(`→ Talk: ${text}`);
  const t0 = Date.now();
  const result = await talk(text);
  console.log(`← ${Date.now() - t0}ms`, JSON.stringify(result, null, 2));

  const after = await getLog(before.next);
  console.log(`\n— new surgery lines (${after.lines.length}) —`);
  for (const l of after.lines) console.log(fmt(l));

  // Audit trail (often has capability.requested even when surgery is quiet)
  try {
    const g = typeof result.goalId === "string" ? result.goalId : "";
    const aq = g ? `${BASE}/api/audit?goalId=${encodeURIComponent(g)}` : `${BASE}/api/audit`;
    const ares = await fetch(aq);
    if (ares.ok) {
      const body = (await ares.json()) as { records?: { type?: string; summary?: string; why?: string }[] };
      const recs = body.records ?? [];
      console.log(`\n— audit (${recs.length}) —`);
      for (const r of recs.slice(-12)) {
        console.log(`${(r.type || "").padEnd(28)} ${(r.summary || "").slice(0, 80)}${r.why ? " · " + r.why.slice(0, 60) : ""}`);
      }
    }
  } catch {
    /* optional */
  }

  if (wait || result.status === "waiting" || result.outcome === "needs_capability") {
    await waitDoctor(after.next);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
