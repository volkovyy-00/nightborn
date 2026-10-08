---
id: T01
title: Audit schema + file sink
status: done
wave: 0
depends: []
files:
  - src/audit.ts
  - audit/.gitkeep
  - audit/README.md
---

# T01 — Audit schema + file sink

## Goal
Append-only, goal-centric audit log ready to feed a later evaluator (Jev). Independent of Doctor/agent loop.

## Done when
- [x] `src/audit.ts` exports `AuditRecord` type + `append` / `list({ goalId?, since? })`
- [x] Records land as JSONL under `audit/` (one file per day or per goal — pick one, document in `audit/README.md`)
- [x] Every record has `id`, `ts`, `type`, `summary`; optional `why`, `goalId`, `data`, `evalHint`
- [x] Unit-free smoke: small `tsx` snippet or comment in README showing append + list
- [x] Never logs raw secrets

## Notes
Do not touch `surgery.log`. Parallel-safe with T02–T05.
