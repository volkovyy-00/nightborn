# Agent memory

Long-term agent memory lives here as markdown. The host (`src/memory.ts`) is the only writer — skills do not get raw filesystem access outside this helper.

## Layout

```text
memory/
  goals/<id>.md          # active / parked goals
  entities/<name>.md     # durable facts (sites, people, deals, …)
  journal/YYYY-MM-DD.md  # append-only daily notes
```

| Area | Purpose |
|------|---------|
| `goals/` | One file per goal: status, constraints, notes the agent updates while working. |
| `entities/` | Named dossiers the agent revisits across sessions (e.g. `sites.md`, `deals.md`). |
| `journal/` | Dated log lines via `MemoryStore.appendJournal` — one file per UTC day. |

## Conventions

- Paths passed to `MemoryStore` are **relative to this directory** (e.g. `goals/used-car-deals.md`). Absolute paths and `..` are rejected.
- Prefer markdown with a clear `#` title; YAML frontmatter is fine when useful.
- Goals may be rewritten; journal days are append-oriented.
- Do not put secrets or API keys in memory files — use `.env` + Broker.
