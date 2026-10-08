---
id: T06
title: Doctor inbox Markdown I/O
status: done
wave: 1
depends: [T02]
files:
  - src/doctor/brief.ts
  - src/doctor/inbox.ts
  - doctor/inbox/.gitkeep
  - doctor/wip/.gitkeep
  - doctor/done/.gitkeep
  - doctor/failed/.gitkeep
  - doctor/README.md
---

# T06 — Doctor inbox Markdown I/O

## Goal
Markdown-first capability briefs with YAML frontmatter; enqueue/dequeue without running Forge.

## Done when
- [x] Frontmatter fields: `requestId`, `goalId`, `auditRef`, `title`, `suggestedCaps`, `defaultsHint?`, `changeOf?`
- [x] Body sections: Intent, Minimal success, Why (see vision §5 Step C)
- [x] `submit(brief)` writes `doctor/inbox/<requestId>.md` and returns immediately
- [x] `take()` moves one file inbox → wip; `complete` / `fail` move to done/failed
- [x] Parse + serialize round-trip tested (small script or assert in comments)
- [x] `doctor/README.md` documents layout

## Notes
Do not call Forge here (T07). May import types/hints from `src/defaults.ts` (read-only).
