---
id: T14
title: Used-car path smoke
status: done
wave: 2
depends: [T09, T10]
files:
  - fixtures/agent/
  - scripts/smoke-agent-runtime.ts
---

# T14 — Used-car path smoke

## Goal
Prove explore → request scrapers → Doctor ready → (optional) call capability / needs_secret → resume, with audit `why` recorded.

## Done when
- [x] Script or fixture-driven smoke under `scripts/smoke-agent-runtime.ts`
- [x] OFFLINE-friendly where possible (mock HTTP / mock bland)
- [x] Asserts: inbox brief written; `capability.ready` (or `needs_secret` then ready); audit lines with `why`; agent park/resume
- [x] Document how to run in `fixtures/agent/README.md`
- [x] Does not require live Bland credits (live call optional footnote)

## Notes
**Last** integration ticket. Read-only on core modules except fixtures/scripts write-set.
