# Live agent troubleshooting

How to drive and debug the running Nightborn host on `feature/agent-runtime` without mixing smoke into the UI log.

## Preconditions

- Branch: `feature/agent-runtime`
- Host: `npm start` → `http://127.0.0.1:8787` (do not start a second process if one already owns the port)
- `.env`: `CHARTER_PIN`, and for live listings `BRAVE_API_KEY`
- Talk/Forge planner: default `PLANNER=pi` needs `OPENROUTER_API_KEY` / `PI_MODEL`. `PLANNER=cursor` needs `CURSOR_API_KEY` (SDK; optional `PLANNER_CURSOR_MODEL=composer-2.5`)
- Keep `JUDGE_MODE=0` for real Talk (judge mode writes `surgery.fixture.log`, not the UI log)
- Keep `OFFLINE=0` for live Brave/Bland; `OFFLINE=1` uses `/mock/*`
- Doctor forge-first: listings call Forge; check surgery.log for `author=cursor|pi` (not silent scaffold). Scaffold only if forge throws, or set `FORGE_SCAFFOLD_FIRST=1` for instant canned VDP scrapers
- Optional Forge-only Cursor CLI when `PLANNER=pi`: `FORGE_BACKEND=cursor`, `agent` on `PATH`, once run `agent login` (no API key)
- Listings Doctor test fails if stdout is only shopping-index hubs (no vehicle cards)

## Surgery log channels (do not mix)

| File | Who writes it |
|------|----------------|
| `surgery.log` | Live host / UI (`/api/log`) |
| `surgery.smoke.log` | `SMOKE_AGENT=1` / `scripts/smoke-agent-runtime.ts` |
| `surgery.fixture.log` | `JUDGE_MODE=1` |

UI and `live-debug` read **live** only. If Talk “works” but the UI log is empty, check whether the host was started with `JUDGE_MODE=1`.

## CLI: talk + poll Doctor

```bash
# Tail live surgery log
npx tsx scripts/live-debug.ts --tail 40

# One Talk turn; --wait polls until install/ready or fail
npx tsx scripts/live-debug.ts --wait "Look at used-car listings on Cars.com and Edmunds and give me the best deals under \$10k."
```

Optional: `BASE=http://127.0.0.1:8787`.

After a turn, also check:

```bash
# Goal query + park state
ls memory/goals/ memory/waits/
# Doctor queue
ls doctor/inbox doctor/wip doctor/done doctor/failed
# Installed hands
ls skills/
# Goal audit (why / plan types)
curl -sS "http://127.0.0.1:8787/api/audit?goalId=GOAL_ID" | python3 -m json.tool | head
```

## Chat / SSE

- Source of truth: `memory/goals/<goalId>.messages.jsonl`
- Live UI: `EventSource` → `GET /api/messages/stream` (reconnect uses `Last-Event-ID`)
- Catch-up / debug: `GET /api/messages?since=ID` (optional `goalId=`)
- Talk HTTP returns early on `wait`; later status/assistant lines arrive over SSE — do not expect one long Talk response
- Conn strip should read `live · sse + /api/log` when the stream is open

## UI checklist

1. Open `http://127.0.0.1:8787`
2. Toggle **Audit** for goal `why` / `agent.plan` types
3. Mode pill should show **GROWING · … · DOCTOR** while parked, then **RUNNING · skill** on resume
4. Chat: gap → install status → running → per-scraper results → final **Best deals for…** list (not “Ranking from results above”)
5. Surgery log: `gap` (`doctor_required`) → `doctor` (enqueued / received / working) → `forge` (skillSource) → `test` (stdout) → `install`
6. After ready: `reuse` with a real query (e.g. `used cars under 10000`), not empty / `continue`

## Symptom → likely cause

| Symptom | Check |
|---------|--------|
| Reply is chat-only (“Requesting tools…”) and nothing grows | Planner skipped `request_capability`. Loop forces a Pi replan, then `hostPreserveUserAskBrief` (verbatim userAsk); confirm `agent.plan` includes `request_capability` |
| `wait` with empty `requestIds` / “Working.” | No-op plan; empty waits are ignored; growth asks should hit forced replan or `hostPreserveUserAskBrief` |
| Gap recognized but no forge lines | Doctor not kicked, or log channel wrong (`JUDGE_MODE` / smoke file) |
| What did Forge see / return? | Surgery `forge debug · path=staging/forge_debug/…` → open that dir (`prompt.txt`, `stdout.txt`, `tools.jsonl`, `result.json`). Default on; `FORGE_DEBUG=0` disables |
| `doctor` **needs_secret** | Add named key to `.env`, restart host (MVP has no secrets UI) |
| `warden` **protected_path:/** | Skill source contains a `"/…"` string literal; scaffolds must use `String.fromCharCode(47)` |
| `test` **search 429** | Brave rate limit; skill retries with backoff; wait and retry, or slow sequential Doctor forges |
| Install OK but results are `example.com` | Old stub scaffold still installed — delete `skills/scrape_*` and re-ask so Doctor reforges site-scoped Brave skills |
| Reuse with empty query | Goal memory missing `query:` — see `memory/goals/<goalId>.md`; resume should inject `query:…` observations |
| Smoke pollutes UI log | Should not anymore; confirm smoke uses `surgery.smoke.log` |
| Conn strip says `host writes surgery.fixture.log · UI reads live` | Host started with `JUDGE_MODE=1` / smoke / `SURGERY_CHANNEL` — restart with live channel |
| Chat stuck after gap / no resume lines | SSE down — check Network for `/api/messages/stream`; restart host after code change |
| Gap then silence (no chat) after missing API key | Should wake with needs_secret chat; if not, check resume bridge + SSE |
| Duplicate user bubbles | Optimistic UI + SSE user; should dedupe via `pendingUser` |

## Restart / clean

```bash
# Restart host after code changes (tsx does not hot-reload)
pkill -f 'tsx src/server.ts'   # only if you own that process
PORT=8787 npm start

# Wipe stub/forged scrapers so Doctor rebuilds them
rm -rf skills/scrape_cars_com skills/scrape_edmunds

# Destructive full reset (log rotate + wipe forged skills) — only when asked
npm run fresh
```

## Offline smoke (does not use live UI log)

```bash
OFFLINE=1 SMOKE_SKIP_CALL=1 npx tsx scripts/smoke-agent-runtime.ts
# → surgery.smoke.log
```

## Code map

| Concern | Where |
|---------|--------|
| Talk / tools | `src/talk.ts` |
| Goal transcript + SSE fanout | `src/transcript.ts` |
| SSE + `/api/messages` | `src/server.ts` |
| Action loop, listing fallback, goal query | `src/agent/loop.ts` |
| Live Create blocked | `src/runner.ts` `executeJob` |
| Doctor forge / site scrape scaffold | `src/doctor/worker.ts` |
| Forge debug dumps | `src/forgeDebug.ts` → `staging/forge_debug/` |
| Log channels | `src/log.ts` |
| Defaults (`listings.http_scrape`) | `defaults/capabilities.yaml` |
| Live CLI | `scripts/live-debug.ts` |
