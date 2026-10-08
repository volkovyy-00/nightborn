# Nightborn agent runtime vision

**Status:** design vision (not implemented).  
**Audience:** humans and coding agents shaping the next architecture.  
**Relation to today:** the current host is a synchronous workshop — one Talk emit → one Job → Create/Reuse → reply. This document describes the async, capability-growing runtime we want next. Evaluation (approve/deny/raise) is **deferred**; the audit trail must be ready to feed it.

Indicative APIs, types, and file layouts below are **examples for discussion**, not a frozen contract. Prefer the ergonomics principles over any particular name.

---

## 1. Product intent

The user gives an open-ended goal. The agent should:

1. Explore and decompose the goal.
2. Notice when it lacks a capability (e.g. scrapers for sites 1/2/3, or outbound phone).
3. Request a **minimal** capability from the **Doctor** (Forge inbox).
4. Keep going when notified that the capability is ready — without the user re-stating the goal.
5. Ask the user only when something truly external is required (usually a new API key).
6. Remember across sessions (markdown memory) and wake itself (one-shot or cron-like).

**Car deals example (end-to-end story):**

> “Look at used-car listings and give me the best deals.”

Indicative agent internal monologue (not necessarily shown to the user):

1. *Search where people list used cars in this region.*
2. *I have three listing surfaces: A, B, C.*
3. *I need scrapers for A, B, and C — request three minimal scrape capabilities (or one parameterized).*
4. *Doctor unblocks me; I scrape.*
5. *Listings include phone numbers for details — I should grow / use a call capability.*
6. *Call sellers conversationally (one question at a time); write notes to memory; rank deals.*
7. *Optional: schedule a wake tomorrow to re-check new listings.*

---

## 2. Ergonomics bar

### 2.1 For coding agents (implementing this)

| Principle | Meaning |
|-----------|---------|
| **Small, named surfaces** | Capability request, Doctor result, Event, Audit record, Memory doc, Schedule entry — each has one obvious module/folder. |
| **Append-only where it matters** | Audit and surgery-style logs never rewrite history; memory files may edit, but audit cites paths + hashes/timestamps. |
| **Sync path stays boring** | Existing Create → Warden → Broker → Test → Install remains the way skills enter `skills/`. Doctor *uses* that pipeline; it does not bypass Warden. |
| **Indicative ≠ sacred** | Rename fields freely if ergonomics improve; keep the *roles* (Agent, Doctor, Audit, Event, Memory, Schedule). |
| **Defaults before invention** | Doctor consults a defaults registry before inventing random APIs. |
| **Fail closed on secrets** | Unknown env keys never appear in child processes until the user supplies them and Broker wires them. |

### 2.2 For the runtime agent (Talk / planner)

| Principle | Meaning |
|-----------|---------|
| **One next action** | Prefer “request capability X” or “run skill Y” over dumping a 20-step essay. |
| **Minimal asks** | Capability briefs describe the *smallest* unblock, not a perfect product. |
| **Non-blocking wait** | After a capability request, the agent parks the goal (memory + wait state), does not busy-spin the user. |
| **Resume on event** | `capability.ready` continues the same goal; user should not have to re-prompt. |
| **Conversational side effects** | Phone skills ask one question at a time (already the Bland skill direction). |
| **Honest blockage** | If blocked on a key, say what key and why — once — via a structured `needs_secret` event, not a guilt trip. |

---

## 3. Roles

| Role | Responsibility |
|------|----------------|
| **Agent** | Pursues goals; explores; runs skills; requests capabilities; writes memory; schedules wakes. |
| **Doctor** | Reads capability briefs from an inbox; creates/patches minimal skills via Forge+Warden; asks user for secrets when required; emits readiness events. |
| **Audit** | Records what happened and *why* a capability was requested; optional UI; later feed for evaluation. |
| **Broker / Warden / Charter** | Unchanged leash: caps, scan, grants. Doctor cannot grant what charter denies. |
| **User** | Sets goals; optionally watches audit; supplies API keys when asked; may later be replaced/assisted by an evaluator (Jev). |

---

## 4. High-level architecture

```text
┌─────────────┐     goal / chat      ┌──────────────────┐
│    User     │ -------------------> │  Agent runtime   │
└─────────────┘                      │  (loop + state)  │
       ^                             └────────┬─────────┘
       | needs_secret / optional UI           |
       |                              ┌───────┼────────┐
       |                              v       v        v
       |                         run skill  request   memory /
       |                              |     capability schedule
       |                              v       v
       |                         Runner/  Doctor inbox
       |                         Warden      |
       |                              |       v
       |                              |    Forge minimal skill
       |                              |       |
       |                              <--- events (ready / failed)
       |
       +---------- audit (optional view) --------------+
```

---

## 5. Concrete flow — used cars (step by step)

### Step A — Goal accepted

User: *“I want you to look at used car listings and give me the best deals.”*

Agent writes memory (indicative path):

```markdown
<!-- memory/goals/2026-10-08-used-car-deals.md -->
# Goal: best used-car deals

Status: exploring
Constraints: prefer local listings; verify by phone when numbers exist
Notes:
- (empty)
```

Audit (indicative):

```json
{
  "type": "goal.started",
  "goalId": "goal_used_car_deals",
  "userText": "I want you to look at used car listings and give me the best deals.",
  "ts": "2026-10-08T20:00:00Z"
}
```

### Step B — Explore where to look

Agent runs an existing search skill (or requests one if missing): *“Where are used cars listed for this region?”*

Observation (indicative items):

```json
{
  "items": [
    { "title": "Site A marketplace", "url": "https://a.example/cars" },
    { "title": "Site B classifieds", "url": "https://b.example/used" },
    { "title": "Site C auctions", "url": "https://c.example/listings" }
  ]
}
```

Agent updates memory: sites A/B/C chosen.  
Internal next action: *need scrapers for A, B, C.*

### Step C — Capability requests (parallel OK)

Agent enqueues **three** minimal briefs (or one brief with three targets). It does **not** block the HTTP response forever; it parks the goal as `waiting_on_capabilities`.

Indicative brief document in the Doctor inbox:

```markdown
<!-- doctor/inbox/2026-10-08T20-01-00Z_scrape-site-a.md -->
# Capability request

- requestId: req_scrape_a
- goalId: goal_used_car_deals
- requestedBy: agent
- auditRef: aud_01J...

## Intent
Scrape used-car listing cards from Site A.

## Minimal success
Given `{ "query": "BMW under 10k" }`, return
`{ "items": [{ "title", "url", "date?", "phone?" }] }`
with ≥1 item when the site has matches.

## Suggested caps
- net:fetch

## Defaults hint
- category: listings.http_scrape
- see defaults/capabilities.yaml

## Why (for audit / later eval)
Goal needs multi-site coverage; Site A appeared in exploration results.
Agent cannot continue ranking without structured listings from A.
```

Same for B and C (`req_scrape_b`, `req_scrape_c`).

### Step D — Doctor unblocks

Doctor picks `req_scrape_a`:

1. Load `defaults/capabilities.yaml` → HTTP scrape template guidance.
2. Forge minimal `skillSource` (or free-form Forge).
3. Warden PRE → Test → Install → `skills/scrape_site_a/`.
4. Emit event (non-interrupting).

Indicative event:

```json
{
  "type": "capability.ready",
  "requestId": "req_scrape_a",
  "goalId": "goal_used_car_deals",
  "skill": "scrape_site_a",
  "ts": "2026-10-08T20:03:12Z"
}
```

Agent wake handler (does not require a new user message):

- Load goal memory.
- Mark A unblocked; if B/C still pending, wait or scrape A immediately.
- When enough scrapers ready → run them → merge items into memory.

### Step E — Emergence: phones ⇒ call capability

Scraped items include phones:

```json
{
  "items": [
    {
      "title": "2018 Golf 1.6 — €9.2k",
      "url": "https://a.example/listing/123",
      "phone": "+393206246334"
    }
  ]
}
```

Agent thinks: *details need a call.* Enqueues:

```markdown
# Capability request
- requestId: req_place_outbound_call
- Suggested caps: notify:phone, net:fetch
- Defaults hint: voice.outbound_bland
- Why: listings expose phones; goal asks for best deals → verify availability/price by call
```

Doctor checks defaults → Bland; if `BLAND_API_KEY` missing → **do not install a lying skill**; emit:

```json
{
  "type": "capability.needs_secret",
  "requestId": "req_place_outbound_call",
  "envKeys": ["BLAND_API_KEY"],
  "message": "Outbound calls need a Bland API key. Add BLAND_API_KEY to .env (or paste here).",
  "defaultsRef": "voice.outbound_bland"
}
```

User supplies key once → Doctor finishes Install → `capability.ready` → agent places conversational calls (one question at a time) → writes outcomes to memory → final ranked chat (and optional schedule).

---

## 6. Indicative APIs

> **INDICATIVE** — shapes for ergonomics discussion. Names and transport (in-process vs HTTP vs files) may change.

### 6.1 Agent runtime loop

```ts
// INDICATIVE — docs/AGENT_RUNTIME_VISION.md
type AgentAction =
  | { type: "chat"; text: string }
  | { type: "run_skill"; skill: string | null; intent: string; query: string; needs: string[] }
  | { type: "request_capability"; brief: CapabilityBrief }
  | { type: "request_capability_change"; skill: string; brief: CapabilityBrief }
  | { type: "write_memory"; path: string; markdown: string }
  | { type: "schedule"; schedule: ScheduleSpec }
  | { type: "wait"; reason: string; requestIds?: string[] };

async function agentTurn(ctx: {
  goalId: string;
  userText?: string;       // absent on event-driven wake
  event?: RuntimeEvent;    // capability.ready, schedule.fired, ...
  memory: MemoryStore;
  audit: AuditSink;
}): Promise<AgentAction[]> {
  // Model chooses 1..N actions; host executes with caps / queues.
  // Prefer small batches: e.g. three request_capability, then wait.
}
```

Ergonomic default: host allows **multiple `request_capability` in one turn**, but still **one `run_skill` at a time** (or a small parallel pool later). Continue-step budget is **large** (e.g. tens to hundreds), with wall-clock and spend guards — not `MAX_CONTINUE_STEPS=4`.

### 6.2 Capability brief (Doctor inbox item)

```ts
// INDICATIVE
type CapabilityBrief = {
  requestId: string;
  goalId: string;
  auditRef: string;
  title: string;
  intent: string;
  minimalSuccess: string;     // human + machine readable contract
  suggestedCaps: string[];    // must ⊆ charter when installed
  defaultsHint?: string;      // key into defaults/capabilities.yaml
  changeOf?: string;          // skill name if this is a patch request
  why: string;                // for audit + later eval
};
```

File-form ergonomics (good for agents and git):

```text
doctor/
  inbox/     # pending briefs (*.md or *.json)
  wip/       # doctor currently forging
  done/      # archived with result skill name
  failed/    # with error + auditRef
```

### 6.3 Doctor service

```ts
// INDICATIVE
interface Doctor {
  /** Non-blocking: enqueue brief; returns requestId */
  submit(brief: CapabilityBrief): Promise<{ requestId: string }>;

  /** Worker tick: forge minimal skill or emit needs_secret */
  processNext(): Promise<void>;

  /** Agent asks to tighten/fix an installed skill */
  requestChange(skill: string, brief: CapabilityBrief): Promise<{ requestId: string }>;
}

// Pseudocode processNext
async function processNext() {
  const brief = await inbox.take();
  const defaults = await loadDefaults(brief.defaultsHint);
  const missing = defaults.envKeys.filter((k) => !process.env[k]);
  if (missing.length) {
    await events.emit({ type: "capability.needs_secret", requestId: brief.requestId, envKeys: missing });
    await audit.append({ type: "doctor.blocked_on_secret", brief, missing });
    return; // park brief until secrets.provided
  }
  const artifact = await forgeMinimal(brief, defaults); // existing Forge path
  const result = await wardenInstall(artifact);         // existing Warden path
  await events.emit({
    type: "capability.ready",
    requestId: brief.requestId,
    goalId: brief.goalId,
    skill: result.skill,
  });
}
```

### 6.4 Events (non-interrupting)

```ts
// INDICATIVE
type RuntimeEvent =
  | { type: "capability.ready"; requestId: string; goalId: string; skill: string }
  | { type: "capability.failed"; requestId: string; goalId: string; error: string }
  | { type: "capability.needs_secret"; requestId: string; envKeys: string[]; message: string }
  | { type: "secrets.provided"; envKeys: string[] }
  | { type: "schedule.fired"; scheduleId: string; goalId: string }
  | { type: "audit.flag"; auditId: string; note: string };

interface EventBus {
  emit(e: RuntimeEvent): Promise<void>;
  subscribe(handler: (e: RuntimeEvent) => Promise<void>): () => void;
}
```

UI may toast these; the **agent** must resume without requiring a new user prompt.

### 6.5 Defaults registry

```yaml
# INDICATIVE — defaults/capabilities.yaml
listings.http_scrape:
  description: Fetch listing cards over HTTP and map to items[]
  caps: [net:fetch]
  envKeys: []   # or [BRAVE_API_KEY] if search-backed
  notes: |
    Prefer site HTML/JSON already public. No headless browser in MVP unless charter grows.

search.web:
  caps: [net:fetch]
  envKeys: [BRAVE_API_KEY]
  fallbackEnvKeys: [TAVILY_API_KEY]

voice.outbound_bland:
  caps: [notify:phone, net:fetch]
  envKeys: [BLAND_API_KEY]
  notes: |
    POST https://api.bland.ai/v1/calls
    Conversational: one question per turn.
```

### 6.6 Audit (eval-ready)

```ts
// INDICATIVE
type AuditRecord = {
  id: string;
  ts: string;
  goalId?: string;
  type: string; // goal.started | agent.action | capability.requested | doctor.* | skill.ran | ...
  summary: string;
  why?: string;
  data?: Record<string, unknown>;
  // Stable for later evaluators (Jev, etc.)
  evalHint?: {
    decision?: "approve" | "deny" | "raise" | "pending";
    rulesRef?: string; // e.g. evaluation/rules.md#outbound-calls
  };
};

interface AuditSink {
  append(r: Omit<AuditRecord, "id" | "ts"> & { id?: string }): Promise<AuditRecord>;
  list(filter: { goalId?: string; since?: string }): Promise<AuditRecord[]>;
}
```

Optional UI: “show audit” toggle — default off for demo cleanliness; always recorded.

**Evaluation (deferred):** an external or later in-process judge reads audit + `evaluation/rules.md` and sets `evalHint.decision`. Do not block Doctor on eval in MVP unless explicitly enabled later.

Indicative rules stub:

```markdown
<!-- INDICATIVE — evaluation/rules.md -->
# Evaluation rules (deferred engine)

## outbound-calls
- Raise if calling without user-visible goal mentioning contact/verify.
- Deny if capability request asks for secrets:read or notify:email.
- Approve minimal notify:phone when listings already contain phones and goal is deal-finding.

## scrape-requests
- Approve net:fetch scrapers scoped to URLs discovered in-session.
- Raise if scrape target is unrelated to goal memory.
```

### 6.7 Memory (markdown)

```text
memory/
  goals/<id>.md
  entities/sites.md
  entities/deals.md
  journal/YYYY-MM-DD.md
```

Indicative helper:

```ts
// INDICATIVE
interface MemoryStore {
  read(path: string): Promise<string | null>;
  write(path: string, markdown: string): Promise<void>; // host enforces root + charter
  appendJournal(line: string): Promise<void>;
}
```

### 6.8 Scheduling

```ts
// INDICATIVE
type ScheduleSpec =
  | { kind: "once"; at: string; goalId: string; note?: string } // ISO wake
  | { kind: "cron"; expr: string; goalId: string; note?: string };

// Example agent action
{ type: "schedule", schedule: { kind: "once", at: "2026-10-09T09:00:00+02:00", goalId: "goal_used_car_deals", note: "Re-check Site A for new Golfs" } }
```

Host cron/wake emits `schedule.fired` → agent turn without user text.

### 6.9 HTTP surface (optional later)

If exposed over HTTP (indicative only):

```http
POST /api/agent/goal          { "text": "best used car deals" }
GET  /api/agent/goals/:id
POST /api/doctor/inbox        { brief }
GET  /api/events/stream       text/event-stream
GET  /api/audit?goalId=...
POST /api/secrets             { "BLAND_API_KEY": "..." }   # user paste; never log raw
```

MVP can be **in-process** (same Node host, file inbox + EventEmitter) with zero new routes.

---

## 7. Mapping to current Nightborn

| Current piece | Reuse |
|---------------|--------|
| Talk `emit_job` / `emit_chat` | Becomes one action source; loop + wait/request_capability added |
| Runner Create/Reuse + Forge `skillSource` | Doctor’s install path |
| Warden + charter + Broker | Unchanged leash |
| `surgery.log` | Keep for pipeline; **Audit** is a parallel, richer, goal-centric log |
| Bland conversational skill | Example of a defaults-backed `voice.outbound_bland` capability |
| `soul.md` | Extend with wait/request/resume rules; keep terse user voice |

What current code does **not** do: Doctor inbox, events, multi-request turns, markdown memory store, scheduler, eval-ready audit schema.

---

## 8. Suggested implementation phases

Phasing is guidance, not a freeze.

1. **Audit schema + file sink** (even before the loop) — every capability request gets `why`.
2. **Defaults registry** + **Doctor inbox** (file-based) calling existing Forge/Warden.
3. **Events + agent wait/resume** (in-process bus).
4. **Large continue budget** + multi `request_capability` per turn.
5. **`needs_secret` UX** (CLI or UI paste → `.env` / Broker reload).
6. **Markdown memory** helpers with safe root.
7. **Scheduler** (once + cron).
8. **Optional audit UI**; wire **Jev-class eval** later against `evaluation/rules.md`.

---

## 9. Worked micro-examples

### 9.1 Agent turn requesting three scrapers

```ts
// INDICATIVE return from agentTurn after exploration
[
  {
    type: "request_capability",
    brief: {
      requestId: "req_scrape_a",
      goalId: "goal_used_car_deals",
      auditRef: "aud_100",
      title: "scrape_site_a",
      intent: "Used car listing cards from Site A",
      minimalSuccess: "stdin {query} → items[{title,url,phone?}]",
      suggestedCaps: ["net:fetch"],
      defaultsHint: "listings.http_scrape",
      why: "Exploration listed Site A; need structured cards to rank deals",
    },
  },
  { type: "request_capability", brief: { /* site B */ } },
  { type: "request_capability", brief: { /* site C */ } },
  {
    type: "wait",
    reason: "scrapers for A/B/C",
    requestIds: ["req_scrape_a", "req_scrape_b", "req_scrape_c"],
  },
  {
    type: "write_memory",
    path: "goals/goal_used_car_deals.md",
    markdown: "... Status: waiting_on_capabilities: A,B,C ...",
  },
]
```

### 9.2 Doctor asks for Bland key

```ts
// INDICATIVE event to UI + agent
{
  type: "capability.needs_secret",
  requestId: "req_place_outbound_call",
  envKeys: ["BLAND_API_KEY"],
  message: "Add a Bland API key to place outbound verification calls.",
  defaultsRef: "voice.outbound_bland"
}
```

### 9.3 Resume after ready

```ts
// INDICATIVE wake
agentTurn({
  goalId: "goal_used_car_deals",
  event: { type: "capability.ready", requestId: "req_scrape_a", goalId: "goal_used_car_deals", skill: "scrape_site_a" },
  memory,
  audit,
});
// → [{ type: "run_skill", skill: "scrape_site_a", query: "BMW under 10k", needs: ["net:fetch"] }, ...]
```

---

## 10. Non-goals (for this vision doc)

- Replacing Warden with an LLM judge for install (evaluation may advise later; install stays code-leashed).
- Full browser automation farm on day one.
- Guaranteeing perfect multi-site scrapers — **minimal** unblock only.
- Shipping Jev in the same milestone as the inbox (audit + rules file only).

---

## 11. Resolved decisions (MVP)

| Topic | Decision |
|-------|----------|
| Doctor process | **In-process** in the same Node host. Runs **async**: capability requests enqueue to the inbox; Forge/Warden work is **non-blocking** (does not hold the agent HTTP turn). Agent waits on events (`capability.ready` / `needs_secret` / `failed`). |
| Capability briefs | **Markdown-first** under `doctor/inbox/` (human-readable body + YAML frontmatter for machine fields such as `requestId`, `goalId`, `suggestedCaps`, `defaultsHint`). |
| `run_skill` parallelism | **Sequential** for MVP. Multiple `request_capability` in one turn is fine; skills execute one at a time. |
| `needs_secret` UX | User supplies keys via **`.env` + process reload** (or equivalent Broker refresh). Optional UI paste later; not required for MVP. |

When implementing, prefer the choice that keeps **agent resume** and **Doctor unblock** obvious in the file tree within five seconds of `ls`.

### Indicative async Doctor shape (locked direction)

```ts
// INDICATIVE — in-process, non-blocking
doctor.submit(brief);           // writes doctor/inbox/<id>.md, returns immediately
// agent turn ends or parks on wait{ requestIds }
setImmediate(() => doctor.processNext()); // or queueMicrotask / worker tick
// ... Forge+Warden runs off the request path ...
events.emit({ type: "capability.ready", ... }); // agent resumes without new user text
```
