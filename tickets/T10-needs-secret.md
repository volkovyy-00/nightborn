---
id: T10
title: needs_secret + env reload
status: todo
wave: 2
depends: [T07]
files:
  - src/secrets.ts
  - .env.example
---

# T10 — needs_secret + env reload

## Goal
When Doctor lacks env keys, emit `capability.needs_secret`; user adds to `.env` and reloads; Doctor retries parked briefs.

## Done when
- [ ] Document operator flow in `src/secrets.ts` header comment + `.env.example` note
- [ ] `reloadEnvFromDotfile()` re-reads repo-root `.env` into `process.env` (no logging of values)
- [ ] `retryParkedSecretBriefs()` or Doctor hook: after reload, re-queue briefs waiting on secrets
- [ ] Optional: `POST /api/secrets/reload` that only triggers reload+retry (no body secrets) — only if you must touch server; prefer keeping server edits minimal and note T09 ownership if conflict
- [ ] Never commit real keys

## Notes
If `src/server.ts` must change, do it **after** T09 merges or ask human to serialize. Prefer Doctor-internal retry + manual process restart documented as MVP.
