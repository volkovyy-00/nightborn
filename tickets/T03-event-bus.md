---
id: T03
title: In-process event bus
status: done
wave: 0
depends: []
files:
  - src/events.ts
---

# T03 — In-process event bus

## Goal
Non-interrupting notifications for `capability.ready` / `failed` / `needs_secret` / `schedule.fired`.

## Done when
- [x] `RuntimeEvent` union typed in `src/events.ts`
- [x] `emit(e)` + `subscribe(handler) => unsubscribe`
- [x] Sync in-process (EventEmitter or tiny custom); no Redis
- [x] Handlers may be async; emit does not await all handlers forever (document: fire-and-forget vs serial — prefer serial await with try/catch per handler)
- [x] No HTTP/SSE in this ticket (optional later)

## Notes
UI toast out of scope. Parallel-safe with T01/T02/T04/T05.
