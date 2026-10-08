# Doctor inbox

Markdown-first capability briefs for the in-process Doctor (see `docs/AGENT_RUNTIME_VISION.md` §5 Step C, §6.2, §11).

Forge / Warden processing lives in T07 (`src/doctor/worker.ts`). This tree is only the file queue.

## Layout

```text
doctor/
  inbox/     # pending briefs (*.md) — agent / submit() enqueues here
  wip/       # Doctor currently forging (take() moves inbox → wip)
  done/      # archived successes (complete())
  failed/    # archived failures (fail())
```

Each brief is one file: `<requestId>.md` (filesystem-safe id: `[A-Za-z0-9._-]+`).

## Brief format

YAML frontmatter (machine fields) + Markdown body sections:

| Frontmatter | Required | Notes |
|-------------|----------|--------|
| `requestId` | yes | File basename |
| `goalId` | yes | Agent goal |
| `auditRef` | yes | Audit record id |
| `title` | yes | Short capability name |
| `suggestedCaps` | yes | Flow array, e.g. `[net:fetch]` |
| `defaultsHint` | no | Key into `defaults/capabilities.yaml` |
| `changeOf` | no | Existing skill name if this is a patch |

Body headings (required):

- `## Intent`
- `## Minimal success`
- `## Why`

Example:

```markdown
---
requestId: req_scrape_a
goalId: goal_used_car_deals
auditRef: aud_100
title: scrape_site_a
suggestedCaps: [net:fetch]
defaultsHint: listings.http_scrape
---

## Intent
Scrape used-car listing cards from Site A.

## Minimal success
Given `{ "query": "BMW under 10k" }`, return `{ "items": [{ "title", "url" }] }`.

## Why
Exploration listed Site A; need structured cards to rank deals.
```

## API (`src/doctor/`)

| Function | Module | Behavior |
|----------|--------|----------|
| `serializeBrief` / `parseBrief` | `brief.ts` | Round-trip Markdown ↔ `CapabilityBrief` |
| `submit(brief)` | `inbox.ts` | Write `inbox/<requestId>.md`; returns immediately |
| `take()` | `inbox.ts` | Move one file inbox → wip; parse and return (or `null`) |
| `complete(requestId)` | `inbox.ts` | Move wip → done |
| `fail(requestId)` | `inbox.ts` | Move wip → failed |

Round-trip check: `npx tsx src/doctor/brief.ts`
