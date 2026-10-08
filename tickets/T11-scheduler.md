---
id: T11
title: Once + cron scheduler
status: done
wave: 1
depends: [T03, T04]
files:
  - src/schedule.ts
  - schedules/.gitkeep
  - schedules/README.md
---

# T11 — Once + cron scheduler

## Goal
One-shot `wake_at` and cron-like schedules that emit `schedule.fired` for agent resume.

## Done when
- [x] Persist schedules as markdown or JSON under `schedules/` (document format)
- [x] Support `{ kind: "once", at: ISO }` and `{ kind: "cron", expr }` (use a tiny cron parser dep only if unavoidable — prefer asking before new dep)
- [x] Timer tick in-process; emit `schedule.fired` with `goalId`
- [x] `startScheduler()` / `stopScheduler()` for server lifecycle (call site can be T09)
- [x] README with example once + cron

## Notes
Do not implement full agent planner. Parallel-safe with T06/T08 if files stay in write-set.
