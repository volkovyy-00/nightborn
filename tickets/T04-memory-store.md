---
id: T04
title: Markdown memory store
status: done
wave: 0
depends: []
files:
  - src/memory.ts
  - memory/.gitkeep
  - memory/README.md
---

# T04 — Markdown memory store

## Goal
Long-term agent memory as markdown under a safe root (`memory/`).

## Done when
- [x] `MemoryStore`: `read`, `write`, `appendJournal`
- [x] Paths resolved under `memory/` only — reject `..` and absolute escapes
- [x] Suggested layout documented: `goals/`, `entities/`, `journal/`
- [x] `memory/README.md` explains conventions

## Notes
No agent loop wiring yet (T08/T09). Do not grant skills raw fs outside this helper.
