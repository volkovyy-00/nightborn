# Agent runtime smoke fixtures

Fixture-driven path for **T14 — Used-car path smoke**.

## What it proves

1. Explore (stub observation of listing sites)
2. `request_capability` briefs land in `doctor/inbox/` (Markdown + frontmatter)
3. Agent `wait` parks the goal
4. In-process Doctor forges scrapers (`listings.http_scrape`) → `capability.ready`
5. Agent resume on ready (no user re-prompt)
6. Optional call capability → `capability.needs_secret` → `.env` reload / retry → ready
7. Audit lines include `why` on capability request / doctor secret block / forge

No live Bland credits. OFFLINE mock HTTP (and mock Bland) is started **inside** the smoke script — you do not need `npm start`.

## Run

From repo root, on branch `feature/agent-runtime`:

```bash
OFFLINE=1 npx tsx scripts/smoke-agent-runtime.ts
```

Requires a valid `CHARTER_PIN` in repo-root `.env` (same as `npm start`).  
`BLAND_API_KEY` may be present in `.env`; the smoke temporarily unsets it to exercise `needs_secret`, then reloads from `.env` (or injects a fake offline key if the file has none).

Exit `0` = all asserts passed. Failures print which check broke.

### Optional: skip call / needs_secret leg

```bash
OFFLINE=1 SMOKE_SKIP_CALL=1 npx tsx scripts/smoke-agent-runtime.ts
```

### Live call footnote

A real outbound Bland call is **not** part of this smoke. After install, a live verify would be:

```bash
# with server + real BLAND_API_KEY — not required for T14
# Talk: place a short test call to BLAND_DEMO_PHONE_NUMBER
```

## Files

| Path | Role |
|------|------|
| `used-car-path.json` | Sites, queries, defaults hints, explore items |
| `../scripts/smoke-agent-runtime.ts` | Harness: mock HTTP, agent loop, asserts |
