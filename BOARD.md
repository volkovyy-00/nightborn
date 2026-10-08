# BOARD — Nightborn v4 phase checklist
Plan + gates: `SPEC.md` §14. The human ticks gates; agents tick a task only after its check ran green in this session.

NOW: P0 · NEXT GATE: P1 00:45 · LAST TAG: — · BACKUPS TAKEN: —

## P0 Reset · 21:00–21:45 · tag `t0-reset`
- [x] Live key check (OpenRouter Haiku 4.5 tool call, Brave web) — 20:58
- [x] Sandbox check (`--permission` on Node 22.22.2) — 21:05
- [x] Pi 0.75.5 experiments (non-terminating tool, throw→retry, stats, abort, hook) — review agent
- [x] sauto.cz JSON API live check — 21:11
- [x] SPEC v4 + AGENTS.md: 5 review agents, fixes applied
- [ ] GATE: human reads summary, says Go (also Go for the P1 charter re-pin)

## P1 T1 smart Talk · 21:45–00:45 · tag `t1-smart`
- [x] Charter v4 four blocks + parser + re-pin + `hand_probe` seed (§6)
- [ ] Sandbox flags + output caps (§9 "Execution")
- [ ] `hash_mismatch` on Reuse → Warden DENIED (§8)
- [ ] Runner rule v4 (§9)
- [ ] Talk v4: `use_hand`, plain-text chat, snapshot, summary, stopReason, timeouts, templates (§10)
- [ ] Recipe template + news recipe; skill I/O `{inputs}` (§9)
- [ ] Token fields on log + `/api/talk` (§12, §13)
- [ ] OFFLINE without key; `source:"fixture"` when OFFLINE (§9)
- [ ] `.env.example` + `docs/UI_CONTRACT.md` match v4
- [ ] GATE: chat · News Install w/ tokens · restart → Reuse hand 0 tok · email → one DENIED + WAV
- [ ] take0 recorded, watched, uploaded (agent meanwhile: validate rows 1–4, 6–10)

## P2 T2 explore → recipe · 01:05–03:30 · tag `t2-recipe`
- [ ] Explorer (`web_search`, safe `http_get`, `emit_recipe`) + `sources.md` (§9)
- [ ] `json` + `web` endpoints, inputs, visited-host rule (§9)
- [ ] Hardened fetch guard + Warden v4 scan rows + host checks (§8, §9)
- [ ] sauto fixtures + chips 1–2 + chip backups (§13)
- [ ] UI token counter (§13)
- [ ] GATE: Tesla → Install · restart · BMW i4 → Reuse hand 0 tok · Enyaq works
- [ ] take1 recorded, watched, uploaded (agent meanwhile: validate rows 5, 11–13)

## P3 T3 code (stretch) · 03:50–05:30 · tag `t3-code` (branch `try/code`, only if `t2-recipe` by 03:30)
- [ ] Builder tools + `tool_call` hook + in-loop Warden + fallback (§9 "Code forge")
- [ ] GATE: ≥2/3 rehearsed asks forge in code mode; fallback proven once

## P4 Proof + ship · 05:30–07:14 · tag `t4-final`
- [ ] `validate.ts` complete → results.json with measured numbers (§17)
- [ ] README · validation slide
- [ ] Final take ~06:15 · upload started 06:40 · done 07:00
