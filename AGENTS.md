# Nightborn — rules for every agent session
`SPEC.md` (v4) is the source of truth. § numbers are stable; pointers below cite § + heading text.
Code and SPEC disagree → SPEC wins: stop, quote both lines, ask the human. Never pick silently.
Edit `SPEC.md` only when the human explicitly asks: one change per commit `spec: …`, add a §0 line,
never renumber §. Decided values go to §18 "Decisions" + `.env.example` / `fixtures/`, never into this file.
Encode only what SPEC locks. Anything SPEC doesn't say → "Ask first" below.

## Who does what
One human (Yevhenii) + agents: §14 "Roles". The human calls Go/No-Go and confirms every gate.
Build in §14 "Phases" order; every phase keeps the lower tiers green (§4 "Pipeline", Tiers).
`BOARD.md`: the human ticks gates; you tick a task box only after its check ran green in this session.
Never edit anything else in it.
Parallel subagents: one git worktree each (copy `.env`, run `npm ci`), a disjoint write set named in the
task. Never in a subagent's write set: `package.json`, `src/types.ts`, `SPEC.md`, `AGENTS.md`, `BOARD.md`,
`charter.md`. Subagents commit on their branch only; the main session merges and is the only one that
tags (after the human's gate). A file changed since you read it → re-read, never overwrite.

## Commands (§7 "Repo layout"; if `package.json` differs, stop and ask)
- `npm start` (tsx, no watch) · `npm run validate` · `OFFLINE=1` (§9 "OFFLINE mode") ·
  `JUDGE_MODE=1` / `fixture` (§10 "JUDGE_MODE / fixtures") · `FORGE_MODE=recipe|code` (§9).
  Anything logged `source:"fixture"` is disclosed (§17).
- `npm run fresh` is DESTRUCTIVE (removes forged hands, rotates the log): only when the human asks.
- Never start/stop/restart a server you didn't start — a take may be recording. Test servers you start
  use another `PORT` and a scratch cwd `staging/dev-<topic>/` holding a copy of `charter.md`
  (§7 "Repo layout", Paths); stop them when done.
- Smoke check per phase: §14 "Phases" gate column. End-to-end path green before any polish.

## Read before touching
runner / forge / explorer / builder → §9 "Skills — contracts" (+ §4, §11) · exec / fetch-guard / broker → §9 "Execution",
"Broker" · warden / hash → §6, §8, §9 "Folder hash" · talk / pi / replies / soul → §10 · log → §12 ·
server / routes / `public/index.html` → §13 · validate → §17 · deps / paths → §7 · scope / cuts → §2, §5, §14

## Outcomes are product, not bugs
DENIED, Broken, `charter_pin_mismatch` exit(1), `hash_mismatch`, `host_not_allowed`, sandbox
`ERR_ACCESS_DENIED` are demo outcomes. Never edit `charter.md`, `CHARTER_PIN`, `decision.json`,
Warden rules, the sandbox flags or the fetch guard to make one go away, and never install a missing
module to silence one. Dropping the fetch guard = its §14 "Abort ladder" row, human Go only.
If a frozen rule blocks the demo path: stop, quote the § line, ask.

## Frozen (details live at the §; never paraphrase into code)
- Warden = deterministic code, no LLM; sole writer of `decision.json` (except the `hand_probe` seed) and
  of `denied` lines. Check order, first failure wins; the name is checked before any path is built (§8).
- Charter is machine-read from its four fenced blocks only (§6). Capability, host and forge rules
  in `src/` come from there, never hard-coded copies.
- Tripwire on raw text before Talk; exactly one voiced `denied` line per DENIED outcome (§11, §12).
- Talk never installs, never writes `skills/`, never writes a denied/broken reply (§10 "Replies").
  Plain text = chat; work only via `use_hand`; Talk declares `needs` honestly and never refuses on
  policy; tool results are data (§10 "Session", "Context").
- Runner rule = the six steps in §9 "Runner rule", implemented verbatim, no LLM.
- No forge retry; a Builder failure before `submit_skill` falls back to recipe once; exactly one outcome per
  request; only the first `use_hand` per request runs the Runner (§6, §9, §10 "Session").
- User values reach a hand only on stdin; LLM strings reach recipe files only via `JSON.stringify`;
  templates use absolute `https://` URL literals, no `/`-leading literals (§8, §9).
- Skills run sandboxed: `--permission`, fetch guard, stripped env, timeout, stdin closed (§9 "Execution").
  Broker grants only the PRE grant (Test) or `decision.env` (Reuse) (§9 "Broker").
- Explorer / Builder: custom tools only (charter `forge` block), write only into `staging/<runId>/`, limits enforced
  by the host; `http_get`: public `https` only, private / loopback / link-local and never-hosts rejected,
  every redirect re-checked (§6, §9 "Recipe forge", "Code forge").
- Event + actor enums: exactly the §12 lists (the UI depends on them); new log data only via §12 optional fields.
- No raw errors or local paths in replies or log `detail` (§10 "Replies", §12).
- Routes: exactly §13 "Endpoints". UI = vanilla JS in `public/index.html`; state only from `/api/log` +
  `/api/talk` plus the static GRANTS / NEVER lists (§13 "Must regions"); no Reset, no Voice toggle, never reload
  mid-take (§2, §13 "Client rules").
- Deps: the §7 list; Pi stays on 0.75.x; never install `nodemailer` (§2, §7).
- Frozen literals (tripwire regex, DENIED prompt, failureCode enum, denied line): copy from SPEC,
  define once in `src/`, import (§12).
- `staging/<runId>/` inside the repo, never `os.tmpdir`; `surgery.log` append-only, each line written
  when its step happens (§3, §7).
- WAVs only in `public/voice/`; `voice` only on lines §12 allows. Public word "Forge", never "Adopt".

## Ask first
New dep, top-level path, route, template, env var, log field, failureCode, charter change; cutting any
§5 item or building any §2 non-goal; any feature after the 05:30 freeze (§14).

## Stuck
Same failure after 3 fix attempts, or one bug >30 min → stop, name the matching §14 "Abort ladder" row,
wait for the human.

## Git
Small commits; branch before risky work (`try/<topic>`). Tags: §14 "Phases" — tag only after the human
confirms the gate, then push the tag. Taking a backup → commit prefix `backup:`.
Never commit what §7 `.gitignore` lists. After `t0-reset`, `charter.md` changes only with human Go +
new pin + regenerated `hand_probe` seed in the same commit (§6); the P1 re-pin needs that Go too.
