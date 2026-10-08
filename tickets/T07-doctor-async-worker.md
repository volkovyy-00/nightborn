---
id: T07
title: Doctor async Forge worker
status: done
wave: 1
depends: [T01, T02, T03, T06]
files:
  - src/doctor/worker.ts
  - src/doctor/index.ts
---

# T07 — Doctor async Forge worker

## Goal
In-process Doctor that processes inbox **off the request path**: Forge + Warden non-blocking; emit events; audit why.

## Done when
- [x] `processNext()` (or queue tick): take brief → load defaults → if missing `envKeys` emit `capability.needs_secret` and park brief
- [x] Else forge minimal skill via **existing** `forge` / `writeForgedSkill` / `wardenPre` / Test / `installSkill` (do not bypass Warden)
- [x] On success: emit `capability.ready` with `requestId`, `goalId`, `skill`
- [x] On failure: emit `capability.failed`; move brief to `doctor/failed/`
- [x] Audit appends for blocked_on_secret / forged / failed with `why` from brief
- [x] `kick()` schedules work via `setImmediate` / internal queue — never blocks caller of `submit`
- [x] Export a small `getDoctor()` facade from `src/doctor/index.ts`

## Notes
Sequential Forge inside Doctor is fine. Do not edit `src/runner.ts` / `src/talk.ts` (T09). Reuse Broker grants as Install already does.

Parked `needs_secret` briefs stay in `doctor/wip/` for T10 retry after `.env` reload.
