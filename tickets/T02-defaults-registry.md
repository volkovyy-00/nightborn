---
id: T02
title: Defaults capability registry
status: done
wave: 0
depends: []
files:
  - defaults/capabilities.yaml
  - src/defaults.ts
---

# T02 — Defaults capability registry

## Goal
Sane default services for common capability hints (search, scrape, Bland outbound) so Doctor does not invent APIs blindly.

## Done when
- [x] `defaults/capabilities.yaml` includes at least: `listings.http_scrape`, `search.web`, `voice.outbound_bland`
- [x] Each entry: `description`, `caps[]`, `envKeys[]`, optional `notes`
- [x] `src/defaults.ts`: `loadDefaults()`, `getDefault(hint: string)`
- [x] Missing hint → clear error / `null` (document choice)

## Notes
Align names with vision doc §6.5. No Doctor wiring yet (T07).

Missing hint: `getDefault` returns `null` (does not throw). `loadDefaults` throws if the YAML file is missing/invalid.
