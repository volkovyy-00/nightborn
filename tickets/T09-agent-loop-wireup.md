---
id: T09
title: Wire agent loop into host
status: done
wave: 2
depends: [T07, T08]
files:
  - src/agent/loop.ts
  - src/runner.ts
  - src/talk.ts
  - src/server.ts
---

# T09 — Wire agent loop into host

## Goal
Large continue budget; allow multiple `request_capability` per turn; sequential `run_skill`; park/wait; Doctor kick; resume on events.

## Done when
- [x] After Talk (or new agent planner), host can execute a list of actions
- [x] `request_capability` → doctor.submit + audit + kick worker
- [x] `wait` → parkGoal; HTTP may return “working / waiting on capabilities” without blocking Forge
- [x] `run_skill` → existing Runner path, **one at a time**
- [x] Event resume triggers another agent turn with `event` set (no user text)
- [x] Env `MAX_CONTINUE_STEPS` default **high** (e.g. 64) or unlimited with wall-clock guard; `0` disables multi-step
- [x] Tripwire email DENIED path unchanged (no doctor loop)

## Notes
**Serial ticket** — do not parallelize with T10/T14. Coordinate with T13 if soul conflicts; soul is T13’s write-set — only read soul here.
