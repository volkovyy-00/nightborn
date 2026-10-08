# Nightborn — rules for every agent session
`SPEC.md` is the source of truth. § numbers are stable; pointers below cite § + heading text.
Code and SPEC disagree → SPEC wins: stop, quote both lines, ask. Never pick silently.
Edit `SPEC.md` only when the human explicitly asks: one change per commit `spec: …`, add a §0 line,
never renumber §. Decided values go to §18 "Open decisions" + `.env` / `fixtures/`, never into this file.
Encode only what SPEC locks. Anything SPEC doesn't say → "Ask first" below.

## Who does what
Roles and per-checkpoint duties: §14 "Role split" — ask the human which role they're in if unclear.
Edit only files your current task needs; a file changed since you read it → re-read, never overwrite.
Build in §14 "Checkpoints" order: DENIED before Forge; fixture params before LLM wiring.

## Commands (§7 "Scripts"; if `package.json` differs, stop and ask)
- `npm start` (tsx, no watch) · `npm run validate` · `OFFLINE=1` (§9 "OFFLINE mode") ·
  `JUDGE_MODE=1` (§10 "JUDGE_MODE"). Anything logged `source:"fixture"` is disclosed (§17).
- `npm run fresh` is DESTRUCTIVE (removes forged skills, rotates log): only when the human asks.
- Never start/stop/restart a server you didn't start — a take may be recording.
- Smoke check per checkpoint: §14 "Checkpoints". E2E path green before any polish.

## Read before touching
runner/forge/exec/broker/hash → §9 "How skills run" (+ §4 "Pipeline", §11 tripwire)
warden → §6 "Charter", §8 "Manifest + static scan", §11, §12 · talk → §10 · log → §12
routes → §13 "Merge contract" · `public/index.html` → §13 "Client rules" + cut list, §10 "Voice"
validate → §17 · deps → §7 · scope/cuts/timebox → §2, §5, §14

## Outcomes are product, not bugs
DENIED, Broken, `charter_pin_mismatch` exit(1), `hash_mismatch` are demo outcomes. Never edit
`charter.md`, `CHARTER_PIN`, `decision.json`, the allow-list or Warden rules to make one go away,
and never install a missing module to silence one. If a frozen rule blocks the demo path: stop,
quote the § line, ask. Don't loosen, don't route around.

## Frozen (details live at the §; never paraphrase into code)
- Warden = deterministic code, no LLM: a cap passes only if its exact string is in the charter
  allow-list (§6, §8); sole writer of `decision.json` (except the §7 `hand_probe` seed) and `denied` lines (§3).
- Talk returns chat or a typed Job; never installs, never writes `skills/`, never writes the
  denied/broken reply — templated per failureCode (§10 "Replies").
- Tripwire on raw text before Talk; exactly one voiced `denied` line, `actor: warden` (§11).
- Forge = params only; LLM strings reach files only via `JSON.stringify`; `query` arrives on
  stdin, never in `skill.mjs`; no Forge retry (§9 "Forge").
- Reuse/Create = the 5-step §9 "Runner rule" (tripwire → by name → exactly one http skill by
  capability → ≥2 matches = ambiguous `gap` → else Create). Implement verbatim, no LLM.
- Templates: `http` + `email_send` only (`hand_probe` = `template:"hand"`, no template folder; §3, §9).
  `email_send` imports nodemailer on purpose; never install `nodemailer` or `@types/nodemailer` (§7, §11).
- Search: `SEARCH_PROVIDER` is frozen per §18 #3; global `fetch`, no SDKs (§9 "Broker",
  "Provider request shapes"). Apify = provider variant of `http`, only after tag `c4-reuse-forged`
  + Go, per its §14 abort-ladder row.
- Single package Hono + tsx; no Next.js / SSE / monorepo (§2); UI is vanilla JS in
  `public/index.html` polling `/api/log` (§7, §13).
- Routes: exactly §13 "Merge contract" (2 API + static + `/mock` only when `OFFLINE=1`).
- Deps: the §7 list; `typescript` exact `5.9.3` in `dependencies`. Anything else → Ask first.
- OpenAI structured-output schemas (Talk, Forge params): `.nullable()`, never `.optional()`
  (§10). The Test schema's `date?` stays optional (§9 "Test").
- `staging/<runId>/` inside repo, never `os.tmpdir`; `surgery.log` append-only, each line written
  when its step happens, never batched at the end of the request (§3, §4, §5).
- WAVs only in `public/voice/`; `voice` only on lines §12 allows. Public word "Forge", never "Adopt".
- UI state only from `/api/log` + `/api/talk`; no Reset, no Voice toggle, never reload mid-take
  (§13 "Client rules", §2).
- Frozen literals (tripwire regex, DENIED prompt, failureCode enum, denied line): copy-paste from
  SPEC, define once in `src/`, import. Capability enum: only `charter.md`'s fenced block (§6).

## Ask first
New dep or top-level path (§7), route (§13), template, provider, env var (§9), log field or
failureCode (§12); anything in §2 "Non-goals" or the §5 cut list. Feature freeze = §14 abort-ladder row
"Any new feature". C6 = only fixes to a broken script step (§14 "Checkpoints").

## Stuck
§14 "Go/No-Go": any single bug >30 min → backup. For an agent: same failure after 3 fix
attempts → stop, name the matching §14 abort-ladder backup, wait for the human.

## Git
Small commits; branch before risky work. Tag names: §14 "Tags". Tag only after the human
confirms the smoke check, then push the tag. Taking a backup → commit prefix `backup:`.
Never commit what the §7 `.gitignore` lists. After `c0-pin` no agent edits or reformats `charter.md`
unless the human asks (§6: Go + new pin in the same commit; §14/§15/§17 byte-flip checks excepted).
