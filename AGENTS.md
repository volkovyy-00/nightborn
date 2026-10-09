# Nightborn — agent notes (MVP)

No `SPEC.md`. Truth is the running code, `charter.md`, and what the human asks for.
Grow new skills freely. Prefer small diffs. Ask only when a change would trash demo outcomes
or reshape the whole package.

Runtime vision: `docs/AGENT_RUNTIME_VISION.md`. Live troubleshooting: `docs/LIVE_TROUBLESHOOTING.md`.
Parallel tickets: `tickets/README.md` (honor each ticket `files:` write-set; do not land on `pi` unless asked).

Doctor is in-process and async: capability briefs enqueue; Forge/Warden does not block the agent turn.
Talk/Forge planner: `PLANNER=pi` (default, OpenRouter via Pi) or `cursor` (Cursor SDK `Agent.prompt` → JSON; needs `CURSOR_API_KEY`). Forge-only CLI override when `PLANNER=pi`: `FORGE_BACKEND=cursor` (`agent login`, no API key).
Doctor is forge-first: listing briefs call Forge; canned scaffold only on forge failure (or `FORGE_SCAFFOLD_FIRST=1`). Surgery log `author=cursor|pi|scaffold|fixture`.
Agent parks on `wait` and resumes on events. Secrets: `.env` + reload.
**Talk never Create/Install** — live `run_skill` is Reuse-only; missing skills return `doctor_required` and the loop auto-enqueues Doctor. Fixture+forge inject still Create for validate demos.
Talk/Pi owns `request_capability` (forced replan if noop). Every brief carries verbatim `userAsk`; Forge prompt starts with it. Host does **not** remap Marketplace → Cars.com (last resort copies `userText` into `userAsk`/`intent` only).
Composio (host-only `COMPOSIO_API_KEY`, Node ≥ 22.22.3): **skill-scoped**. Talk asks `request_capability`; Forge may `request_composio_access` for the hand it is forging → Connect Link → Doctor re-forges → `decision.json.composio` → runtime proxy `/api/composio/skill/<name>/execute`. Allow-list starts at `apify`; email/SMTP denied.

## Commands
- `npm start` · `npm run validate` · `OFFLINE=1` · `JUDGE_MODE=1`
- Live debug (host already running): `npx tsx scripts/live-debug.ts "phrase"` · `--wait` polls Doctor/forge/install · `--tail N` log only
- `npm run fresh` is destructive (rotates log, wipes forged skills) — only when asked
- Do not start/stop a server you did not start

## Layout that matters
- Host: Hono + tsx, `src/`, UI in `public/index.html`
- Skills: `skills/<name>/` (`skill.mjs`, `notes.md`, `manifest.json`, `decision.json` after install)
- Charter pin: `charter.md` + `CHARTER_PIN` in `.env` (re-pin + regen `skills/hand_probe/decision.json` if the fence changes)
- Log: append-only surgery channels in cwd — `surgery.log` (live / UI), `surgery.smoke.log` (`SMOKE_AGENT=1`), `surgery.fixture.log` (`JUDGE_MODE=1`); `.env` / `public/` from repo root
- Staging: `staging/<runId>/` inside the repo

## How it works (code is authority)
- Talk → chat or actions; never installs. Tripwire on email/smtp/sms → DENIED specimen (`email_send`)
- Growth: `request_capability` → Doctor inbox → Forge/Warden/Test/Install → `capability.ready`
- Marketplace: Forge requests skill-scoped Composio → Connect Link → forge/install with `decision.composio` → skill uses host proxy at runtime (`src/composio.ts`)
- Runner live: Reuse by name, or by capability for `template:"http"`; Create gap → `doctor_required` (no sync Forge)
- Warden scans + charter allow-list; Broker grants only wired env keys
- Skills: stdin `{query, baseUrl?}` → stdout `{items:[{title,url,date?}]}`; global `fetch`
- Call skills: `notify:phone` + `BLAND_API_KEY`, `decision.template:"call"`, Reuse by name after Doctor/install; Doctor/Create/forge install-test **never dials** (`runWithOutboundBlocked` + skip call test; skills dry-run on `NIGHTBORN_BLOCK_OUTBOUND=1`); live `run_skill` still dials via call gate
- UI: poll `/api/log` + SSE `/api/messages/stream` (goal transcript chat) + `/api/talk` + optional Audit; voice-note beat uses `/api/voice/note` + `/api/voice/learn`
- Chat truth: `memory/goals/<goalId>.messages.jsonl` (append-only); Talk history is derived for the planner only

## Product outcomes (do not “fix” away)
DENIED, Broken, `charter_pin_mismatch`, `hash_mismatch` are expected paths.
Do not install `nodemailer` to silence the email DENIED demo.

## Growth
New REST integration = Forge skill (+ charter cap / Broker key / scan row / OFFLINE mock if needed).
Marketplace SaaS (Apify Actors, etc.) = Forge requests skill-scoped Composio; the installed skill owns the binding.
No feature freeze. Evaluation/policy layers can come later.
