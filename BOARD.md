# BOARD — Nightborn
Single writer: Yevhenii (exception: during C2.5 Max updates only his own NOW line). Agents: read only.
Source of truth: `SPEC.md`. Status truth: `git tag -l` + SPEC §14 "Checkpoints". This board is the plan.
Card = ID · owner · `files:` · § · after · done-when. `files:` = the card's exclusive write-set: agents
write nothing outside it (need more → stop, ask the human); no two NOW cards share a path.
A card never authorises an edit `AGENTS.md` forbids. WIP 1 per person; Blocked doesn't count.
Sync: `git pull --rebase` before a card, before every push, and right after "tag pushed".
C3 work stays on a branch until `c2-denied` is tagged; take0 is recorded from that tag.

NOW   Max: —   ·   Yevhenii: —
NEXT ALARM: C0 21:30          LAST TAG: —          BACKUPS TAKEN: —

## ⛔ Blocked (15 min max → §14 abort-ladder backup)
- (ID · what · waiting on · since HH:MM)

## Confirm at kick-off
- [ ] Pre-written charter prose (Y0.1) allowed before 21:00? (§14 "Pre-event": confirm at kick-off)
- [ ] Repo visibility (§18 #8)

## Pre-event · Wed 7 Oct by 22:00
- [ ] P1 Yevhenii · `files:` `fixtures/http/news-<slug>.json`, `SPEC.md` (§18 #7 Pick) · §18 #3 #7 · done: Brave key confirmed (provider frozen, §18 #3); Company A/B picked; ≥3 recent items for both in <5 s (else Tavily fallback, §18 #3)
- [ ] P2 Yevhenii · `files:` `public/voice/denied.wav` `install.wav` `broken.wav` · §10 "Voice", §18 #4 · done: all three rendered with the frozen voice (§18 #4, no candidate pick); denied line understood on one play through laptop speakers, <4 s
- [ ] P3 Max · scratch only · §14 "Pre-event" · after P1 · done: flat Talk schema tried on ~10 prompts incl. exact chips; one provider curl per company
- [ ] P4 Yevhenii · no repo files · §14 C2.5, §16 · RISKIEST · done: system audio captured (macOS built-in recorder usually can't: try QuickTime or OBS + BlackHole loopback; if both fail, WAV added in the edit and subtitled); hotspot upload tested

## Planning window · 18:25–21:00 (no code)
- [ ] Y0.1 Yevhenii · `files:` `charter.md` · §6 "Charter" · done: text + capability enum fenced block handed to Max — target 21:00, hard 21:15 (confirm at kick-off that prose is allowed before 21:00)

## C0 · 21:30 / +0.5 · tag c0-pin
Smoke: One-byte flip of `charter.md` → `exit(1)` + `charter_pin_mismatch`; `boot` line with `charterHash`
If red: +0.75: one-line check, pin in `.env`. C0 never slips
- [ ] M0.1 Max · `files:` `package.json` `package-lock.json` `.gitattributes` `.gitignore` `.env.example` `scripts/fresh.ts` `scripts/validate.ts` (stubs) · §6, §7, §9 "Env names" · done: `npm start` boots; `npm run fresh` + `npm run validate` wired to stub scripts; `.env` loaded via `process.loadEnvFile(<repo-root>/.env)` (repo-root path, not cwd — dev feed and validate run elsewhere; Node ≥ 20.12), no new dependency
- [ ] M0.3 Max · `files:` `src/log.ts` · §12 · after M0.1 · done: append-only JSONL; every line carries `charterHash`
- [ ] M0.2 Max · `files:` `src/charter.ts` `src/hash.ts` `src/server.ts` `charter.md` (pin commit only) `.env.example` · §6 · after M0.3, Y0.1 · done: pin committed with `charter.md` (§6)
- [ ] M0.4 Max · `files:` `src/server.ts` · §13 "Merge contract" · after C0 smoke · done: `/api/log` returns `{lines, next}` with `lines` as parsed objects (§13); `public/` + `.env` from repo root, `charter.md` + `surgery.log` from cwd
- [ ] Y0.3 Yevhenii · `files:` `fixtures/sample-surgery.log` · §7, §12 · after M0.2 · done: every event type; stamped with the pinned `charterHash` (re-stamp on re-pin)

## C1 · 23:30 / +2.5 · tag c1-reuse
Smoke: `hand_probe` via `execFile` (stdin closed), timeout, stripped env; skill byte flip → `hash_mismatch`; ungranted key reads `undefined`; one provider curl OK
If red: +2.75: `OFFLINE=1` fixtures. Broker red ≠ C1 red if `undefined` proof holds. Never block C2 on Broker polish
- [ ] M1.1 Max · `files:` `src/exec.ts` · §9 "Execution" · after `c0-pin`
- [ ] M1.3 Max · `files:` `src/hash.ts` `src/runner.ts` · §9 "Folder hash" · after M1.1 · done: Reuse checks folder hash + charter hash vs `decision.json`
- [ ] M1.2 Max · `files:` `skills/hand_probe/` · §3, §9 "Skill I/O", §9 "decision.json" · after M1.3 · done: package + seed `decision.json` generated from `src/hash.ts`, run once from the repo root (cwd = repo root, so the pinned `charter.md` is hashed; never from `staging/`) (never hand-typed; `env` = key for `SEARCH_PROVIDER`)
- [ ] M1.4 Max · `files:` `src/broker.ts` · §9 "Broker" · after M1.2 · done: grants only `decision.env`; anything else reads `undefined`
- [ ] M1.5 Max · `files:` `src/server.ts` `src/runner.ts` · §13 "Merge contract", §9 "Runner rule" · after M1.4, Y1.4 · done: `/api/talk` `fixture` → Job → Reuse by name; `job` line carries `source:"fixture"`
- [ ] M1.6 Max · `files:` `src/mock.ts` · §9 "OFFLINE mode" · conditional: now if live provider fails, else after `c2.5-take0`, before the jury
- [ ] Y1.1 Yevhenii · `files:` `public/index.html` · §13 cut list ("must" rows), §13 "Client rules" · static layout from 21:00; data via §13 UI dev feed after M0.4
- [ ] Y1.2 Yevhenii · `files:` `public/index.html` · §10 "Voice", §13 "Client rules" · after Y1.1, P2 · done: first poll sets cursor silently; newer lines only, one at a time; unlock on first gesture
- [ ] Y1.3 Yevhenii · no repo files · §9 "Provider request shapes" · after P1 · done: one provider curl OK (for the C1 smoke)
- [ ] Y1.4 Yevhenii · `files:` `fixtures/talk/*.json` `fixtures/forge/pull_company_news.json` · §7, §10 "JUDGE_MODE", §11 · done before 23:00: `denied-email.json` (prompt byte-exact), `reuse-probe.json` (`job.skill` = `hand_probe`, no email keyword), `forge-company-a.json`, `reuse-company-b.json` (`job.skill: null`), forge fixture

## C2 · 01:00 / +4.0 · tag c2-denied
Don't tag `c2-denied` until M2.5 is done (take0 is recorded from this tag after `npm run fresh`).
Smoke: Email chip → tripwire (Talk skipped) → `email_send` → Warden → exactly one `denied` line `actor:warden` → WAV plays once. **Chips/fixture buttons built; UI on real `/api/log`**
If red: +4.25: Warden = manifest allowlist + regex; WAV only
- [ ] M2.1 Max · `files:` `src/runner.ts` · §11 · after `c1-reuse` · done: tripwire on raw text before Talk
- [ ] M2.2 Max · `files:` `templates/email_send/` · §8, §11 · after M2.1 · done: copied to `staging/<runId>/`; `forge` line "fixed template, no LLM"; no `protected_path` literal
- [ ] M2.3 Max · `files:` `src/warden.ts` · §8, §11, §12 · after M2.2 · done: regex + manifest allowlist first (§5 fallback); exactly one `denied` line; staging wiped
- [ ] M2.4 Max · `files:` `src/talk.ts` (reply map only) `src/server.ts` · §10 "Replies" · after M2.3 · done: denied/broken `reply` templated from `failureCode`
- [ ] M2.5 Max · `files:` `scripts/fresh.ts` · §7 · after M2.4 · done: rotates log, removes forged skills + `staging/*`, keeps `hand_probe` for take0
- [ ] M2.6 Max · `files:` `src/warden.ts` · §5 "Should", §8 · optional: branch, 45-min timebox, after `c2.5-take0`, only if C3 is on track · done: TS-compiler scan replaces regex
- [ ] Y2.2 Yevhenii · `files:` `public/index.html` · §13 "Chips (final)", "Client rules" · after Y1.1 · done: 3 chips + fixture buttons; Send/chips disabled while pending
- [ ] Y2.3 Yevhenii · `files:` `public/index.html` · §13 "Merge contract" · after M2.3 · done: server run from repo root (dev feed off); cursor resets when `next < since`
- [ ] Y0.2 Yevhenii · `files:` `soul.md` · §10 "soul.md" · C2 slack, before M3.0
- [ ] Y2.4 Yevhenii · `files:` `README.md` · §14 C2.5 · C2 slack · done: README skeleton; repo visibility confirmed (§18 #8)

## C2.5 · 01:15 / +4.25 · tag c2.5-take0
Smoke: Raw screen + audio: boot pin, `hand_probe` Reuse, DENIED → `video/take0.mp4`. **Upload unlisted by +4.5 via phone hotspot**; dry-run submission (repo visibility, README skeleton, video link)
If red: None — this take is the backup
- [ ] Y2.5 Yevhenii · `files:` `README.md` (video link) · §14 C2.5, §16 · after `c2-denied`, M2.5 · done: recorded from tag `c2-denied` after `npm run fresh`; Reuse via `curl` `POST /api/talk {text, fixture:"reuse-probe.json"}`; uploaded by +4.5; voice-over disclosure ready (hand-written probe, seeded decision, fixture Talk)

## C3 · 03:30 / +6.5 · tag c3-install   (add more cards at the c2-denied tag, not before)
- [ ] M3.0 Max · `files:` `src/talk.ts` · §10, §14 "Role split" · first C3 card, 30-min timebox, done by +4.75 · done: live Talk returns chat or a typed Job; Yevhenii calls the +5.0 row

## C4–C6 · cards added at c3-install
## Apify (optional) · only after `c4-reuse-forged` + Yevhenii Go · §14 abort-ladder row

## Done (by tag)
- (tag HH:MM · card IDs)
