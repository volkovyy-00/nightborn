# Schedules

Persisted wake schedules for the agent runtime. The host (`src/schedule.ts`) loads these on a timer tick and emits `schedule.fired` when due. Agent resume wiring is T09 — this folder only stores specs.

## Format

One JSON file per schedule: `schedules/<id>.json`.

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | Stable id (`sched_…`); filename must match |
| `kind` | yes | `"once"` or `"cron"` |
| `goalId` | yes | Goal to resume when the schedule fires |
| `at` | once | ISO-8601 wake time |
| `expr` | cron | 5-field cron: `minute hour dom month dow` |
| `note` | no | Human hint (why this wake exists) |
| `createdAt` | yes | ISO when the record was written |
| `lastFiredAt` | no | Last fire time (cron dedupe within a minute) |

Cron uses the **host local timezone**. Fields support `*`, lists (`1,3,5`), ranges (`1-5`), and steps (`*/15`, `1-10/2`). Day-of-week: `0` and `7` are Sunday.

One-shot schedules are **deleted** after they fire. Cron schedules stay and update `lastFiredAt`.

## Examples

### Once (wake at a fixed time)

```json
{
  "id": "sched_example_once",
  "kind": "once",
  "at": "2026-10-09T09:00:00+02:00",
  "goalId": "goal_used_car_deals",
  "note": "Re-check Site A for new Golfs",
  "createdAt": "2026-10-08T20:00:00.000Z"
}
```

### Cron (weekday mornings)

```json
{
  "id": "sched_example_cron",
  "kind": "cron",
  "expr": "0 9 * * 1-5",
  "goalId": "goal_used_car_deals",
  "note": "Weekday 09:00 local — refresh listings",
  "createdAt": "2026-10-08T20:00:00.000Z"
}
```

## API (in-process)

```ts
import { addSchedule, startScheduler, stopScheduler } from "./schedule.ts";

await addSchedule({
  kind: "once",
  at: "2026-10-09T09:00:00+02:00",
  goalId: "goal_used_car_deals",
  note: "Re-check Site A",
});

await addSchedule({
  kind: "cron",
  expr: "0 9 * * 1-5",
  goalId: "goal_used_car_deals",
});

startScheduler(); // T09 call site; default tick 15s
// … later …
stopScheduler();
```

Emitted event:

```json
{ "type": "schedule.fired", "scheduleId": "sched_…", "goalId": "goal_used_car_deals" }
```

Do not put secrets in schedule files. Prefer `addSchedule()` over hand-editing production ids.
