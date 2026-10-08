---
id: T12
title: Optional audit UI
status: todo
wave: 2
depends: [T01]
files:
  - public/index.html
  - src/server.ts
---

# T12 — Optional audit UI

## Goal
Toggle to show audit trail for a goal (default off). Ergonomic, not a dashboard sprawl.

## Done when
- [ ] `GET /api/audit?goalId=` returns records from T01 sink
- [ ] UI: small toggle “Audit” — when on, poll/fetch and show monospace list of `ts type summary` (+ why if present)
- [ ] Default off; no clutter in the first viewport beyond a discreet control
- [ ] Does not break existing talk/log voice behavior

## Notes
**Conflicts with T09/T10 on `src/server.ts` / `public/index.html`.** Run only when those are idle, or split: put route in a tiny `src/audit_routes.ts` mounted from server in a 3-line change after T09.
