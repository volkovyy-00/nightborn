# Nightborn — agent notes (MVP)

No `SPEC.md`. Truth is the running code, `charter.md`, and what the human asks for.
Grow new skills freely. Prefer small diffs. Ask only when a change would trash demo outcomes
or reshape the whole package.

Runtime vision: `docs/AGENT_RUNTIME_VISION.md`. Parallel tickets: `tickets/README.md`
(honor each ticket `files:` write-set; do not land on `pi` unless asked).

Doctor is in-process and async: capability briefs enqueue; Forge/Warden does not block the agent turn.
Agent parks on `wait` and resumes on events. Secrets: `.env` + reload.

## Commands
- `npm start` · `npm run validate` · `OFFLINE=1` · `JUDGE_MODE=1`
- `npm run fresh` is destructive (rotates log, wipes forged skills) — only when asked
- Do not start/stop a server you did not start

## Layout that matters
- Host: Hono + tsx, `src/`, UI in `public/index.html`
- Skills: `skills/<name>/` (`skill.mjs`, `notes.md`, `manifest.json`, `decision.json` after install)
- Charter pin: `charter.md` + `CHARTER_PIN` in `.env` (re-pin + regen `skills/hand_probe/decision.json` if the fence changes)
- Log: append-only `surgery.log` in cwd; `.env` / `public/` from repo root
- Staging: `staging/<runId>/` inside the repo

## How it works (code is authority)
- Talk → chat or Job; never installs. Tripwire on email/smtp/sms → DENIED specimen (`email_send`)
- Runner: Reuse by name, or by capability for `template:"http"`, else Create → Forge `skillSource`
- Warden scans + charter allow-list; Broker grants only wired env keys
- Skills: stdin `{query, baseUrl?}` → stdout `{items:[{title,url,date?}]}`; global `fetch`
- Call skills: `notify:phone` + `BLAND_API_KEY`, `decision.template:"call"`, Reuse by name
- UI: poll `/api/log` + `/api/talk`; voice-note beat uses `/api/voice/note` + `/api/voice/learn` (ElevenLabs TTS + Instant Voice Clone)

## Product outcomes (do not “fix” away)
DENIED, Broken, `charter_pin_mismatch`, `hash_mismatch` are expected paths.
Do not install `nodemailer` to silence the email DENIED demo.

## Growth
New REST integration = Forge skill (+ charter cap / Broker key / scan row / OFFLINE mock if needed).
No feature freeze. Evaluation/policy layers can come later.
