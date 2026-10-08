---
id: T08
title: Agent wait / resume stubs
status: done
wave: 1
depends: [T03, T04]
files:
  - src/agent/types.ts
  - src/agent/park.ts
  - src/agent/resume.ts
---

# T08 — Agent wait / resume stubs

## Goal
Park a goal while capabilities are building; resume on `capability.ready` without a new user message. **No** full Talk rewire yet.

## Done when
- [x] Types for `AgentAction` including `request_capability`, `wait`, `run_skill`, `write_memory`, `schedule`, `chat` (indicative → concrete)
- [x] `parkGoal({ goalId, requestIds, reason })` persists wait state via memory helper
- [x] `onRuntimeEvent` handles `capability.ready`: if all `requestIds` satisfied (or policy: resume on each), return a resume context object
- [x] Subscribe to event bus in a `startAgentEventBridge()` that can be called from server later
- [x] No changes to `/api/talk` yet

## Notes
T09 will call into these stubs. Keep API boring and testable.
