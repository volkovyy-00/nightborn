# Nightborn UI ↔ host contract (SPEC v4 §12, §13)

**Audience:** UI agent working in worktree `../nightborn-ui` on branch `feat/ui`.  
**Write set:** `public/**` only (plus regenerating `fixtures/sample-surgery.log` if needed).  
**Visual SoT:** [ui-ref/Nightborn_UI.html](./ui-ref/Nightborn_UI.html) and `artifacts/Nightborn_UI/extracted/Frames.dc.html`.

Backend write set is everything else (`src/`, `templates/`, …). Do not edit `src/`.

---

## Base URL

`http://127.0.0.1:${PORT}` — default `PORT=8787`.

Static: `/` → `public/index.html`, `/voice/*` → `public/voice/*`.  
`/mock/<host>/*` only when the server started with `OFFLINE=1`.

---

## Endpoints

### `POST /api/talk`

Request:

```ts
{ text: string, fixture?: string }  // fixture = filename under fixtures/talk/
```

Response:

```ts
| { kind: "chat"; text: string; say?: string }
| {
    kind: "job";
    job: {
      skill: string | null;
      intent: string;
      inputs: Record<string, string | number>;
      needs: string[];
    };
    outcome: "install" | "reuse" | "denied" | "broken";
    skill: string | null;
    failureCode?: string;
    reply: string;
    items?: Array<{ title: string; url: string; snippet?: string; date?: string }>; // ≤5
    tokens?: { talk: number; forge: number }; // Talk session tokens; forge tokens (0 on Reuse)
    ms?: number;
    say?: string; // one spoken sentence (Talk's VOICE: line or a code template); never on denied / broken
  }
```

- Synchronous; ≤300 s (server `requestTimeout` 310 s).
- Disable Send + chips while a request is in flight.
- For `denied` / `broken`, show `reply` (host template, not the model).
- `say` is spoken, never shown.

### `POST /api/voice`

```ts
{ text: string }  // the `say` of a /api/talk response
```

`200 audio/mpeg` (ElevenLabs TTS, same voice as the WAVs) or `204` = stay silent (no key, `OFFLINE=1`, error, >8 s). Start it as soon as `/api/talk` returns; enqueue the clip only after the board has settled, so it plays after `install.wav`, in the same one-at-a-time queue. Revoke the blob URL after playback.

### `GET /api/log?since=<n>`

```ts
{ lines: LogLine[]; next: number }
```

Poll every **1s**. `lines` are parsed objects (never raw JSONL strings).

```ts
type LogLine = {
  ts: string; // ISO-8601
  actor: "talk" | "forge" | "warden" | "runner" | "broker" | "user" | "test";
  event:
    | "boot" | "job" | "gap" | "forge" | "matched" | "precheck"
    | "test" | "final" | "install" | "reuse" | "denied" | "broken";
  skill: string | null;
  decision: "allow" | "deny" | "pass" | "fail";
  failureCode?: string;
  charterHash: string; // full hex; display first 8 chars
  caps?: string[];
  voice?: string; // e.g. "voice/denied.wav" — only on denied|install|broken
  source?: "live" | "fixture"; // "fixture" on every line while OFFLINE=1, and on fixture-path lines
  detail?: string;  // short reason code; never raw errors or paths
  tokens?: number;  // forge / install (forge cost) / reuse (always 0) / job (Talk tokens at use_hand)
  costUsd?: number; // lower bound
  ms?: number;
};
```

---

## Client rules

1. First poll sets the cursor silently — **no** voice replay of history.
2. Play `voice` only for lines arriving after that cursor; one at a time (queue).
3. Unlock audio on the **first user gesture** anywhere (Send, chip, keydown).
4. If `next < since` (log rotated / fresh) → reset cursor to `0` and treat as first poll again.
5. **Never reload** the page mid-take (drops audio unlock).
6. No Reset button. No Voice toggle. Static label: `VOICE · WAV`.

---

## Chips (byte-aware)

| Chip text | Beat |
|-----------|------|
| `Who are you?` | Chat: Victor answers in plain text, no hand |
| `Find a used Tesla Model 3 under 750 000 Kč` | Forge: the Explorer finds the site itself (SPEC §13) |
| `Find a used BMW i4 under 1 000 000 Kč` | Reuse by name after a restart (same hand, new inputs) |
| `Find a used Škoda Enyaq under 900 000 Kč` | Second Reuse of the same hand |
| `Find the latest news on Anthropic and analyze what it means` | Forge (or Reuse) of a news hand; Talk's summary is the analysis |
| `Email this news digest to my boss every morning.` | DENIED (tripwire; **exact** string) |

Chips sit inside the chat area (`.net`, under the messages); each chip hides after it is clicked, until the page loads again.
Gate-only ask (typed, no chip): `Find Hacker News stories about Rust`.

Placeholder input: `Message Nightborn`.

---

## Visual regions → data

| Region | Source |
|--------|--------|
| CHARTER LOCKED + short hash | Every log line's `charterHash` (first 8 hex; full hash in the tooltip). Compare to boot line — on drift the kicker reads CHARTER DRIFT, the lock opens and the header turns red. |
| LAST DENIED stamp | Latest `denied` line: `failureCode` + time. Its slot is reserved, so the header never changes height. |
| Strip: `charter unchanged since boot · granted ⊆ charter` | Same hash check + union of `caps` on install/reuse ⊆ charter allow-list → `+0 AUTHORITY` |
| `● live` / `offline · reconnecting…` | Whether the last `/api/log` poll succeeded |
| `log · N lines` | Total lines seen (or `next`) |
| `+N FORGED · +0 AUTHORITY` (kicker `MORE HANDS · SAME LEASH`) | FORGED = count of `event === "install"`; AUTHORITY violet at +0, red above |
| PIPELINE stages GAP→FORGE→WARDEN→TEST→INSTALL | Events since last `job` (see below) |
| GRAFT 01–04 | Filled by successive `install` lines (`skill` + caps detail) |
| CHARTER GRANTS / NEVER | Static copy of charter `caps-allow` / `caps-deny` (refreshed at every re-pin; `llm:call` is NEVER) |
| WORKBENCH reply | `/api/talk` `text` or `reply` |
| SURGERY LOG table | `/api/log` columns: time · event · actor · detail · charter |

Artifact **frame tabs** (Boot…Broken) are mock storyboard only — do not require a frames API.

### Token counter (SPEC §13 "Should")

Header strip of three stat blocks — `FIRST ASK n tok` · `REUSE · TALK ONLY m tok` · `HAND 0 tok` (label above, number below) — derived only from `/api/log` lines plus the `/api/talk` response. Lines are grouped into requests: a request starts at each `job` line and runs until the next one. **FIRST ASK** = latest request that ended in `install`: `job.tokens` (Talk up to `use_hand`) + `install.tokens` (forge total), with `install.ms` shown after it (`—` before any install). **REUSE** = latest request that ended in `reuse`: `job.tokens`. **HAND** = that `reuse` line's `tokens` (always `0`; `0` before any reuse too), with that line's `ms` (the hand's own run time) shown under it. When `POST /api/talk` returns `kind:"job"` with `tokens:{talk, forge}`, the matching slot takes the fuller numbers (talk includes the summary): `install` → `talk + forge` (+ response `ms`), `reuse` → `talk`. The override applies only once the matching outcome line has reached the board; the log-derived values are the fallback that survives a reload or a log rotation. Numbers use thin thousands spaces (`4 200 tok`).

### Working bubble + trail

While `POST /api/talk` is pending, the workbench shows a working bubble: a pulsing dot, the current phase (`thinking` until the first log line) and the elapsed seconds. The `/api/log` lines that reached the board since the request was sent are each turned into one plain sentence (e.g. `explore: http_get www.sauto.cz/… 200` → "Read www.sauto.cz/…"; `reuse` → "Ran <skill>: 5 items, hand ran with 0 LLM tokens."). No new route and no new log data: the bubble just reads the step log. When the response arrives, those sentences stay under the reply in a collapsed "how I got this · N steps · Ns" trail. Chat-only replies write no log lines, so they show only `thinking` and the timer. On `install` / `reuse` the model's prose reply sits above the result cards.

### Pipeline mapping

After the latest `job` line:

| Log event | Stage |
|-----------|--------|
| `gap` / `matched` | GAP |
| `forge` | FORGE |
| `precheck` / `denied` | WARDEN (`denied` = red) |
| `test` / `broken` | TEST (`broken` = red) |
| `final` / `install` / `reuse` | INSTALL |

`FORGE_MODE=code` (T3): the Builder's steps are `forge` lines (`write: skill.mjs`, `test 2/3: protected_path`, `submit_skill`). A `precheck` line with `decision:"deny"` + `failureCode` is an in-loop Warden rejection: no `voice`, not an outcome — the Builder rewrites and retries. The one voiced `denied` / `install` / `broken` line still ends the request.

---

## UI bootstrap (no Pi keys)

```bash
# From repo root (or UI worktree after sync)
mkdir -p staging/ui-dev
cp fixtures/sample-surgery.log staging/ui-dev/surgery.log
cp charter.md staging/ui-dev/

# Backend stub/server (other worktree):
#   npm start
# Point the UI at http://127.0.0.1:8787

# Optional keyless demos once JUDGE_MODE=1:
# POST /api/talk { "text": "…", "fixture": "news-anthropic.json" }
```

Until the server is up, you may drive the UI from `fixtures/sample-surgery.log` shapes, then switch to live polling.

---

## Worktree sync

```bash
# After contract commit exists on pi:
cd /home/crimson/dev/nightborn
git worktree add ../nightborn-ui -b feat/ui pi

# UI agent: only edit public/
# Rebase often: git fetch && git rebase pi
# Merge back: from pi worktree, git merge feat/ui
```

Never start/stop a server another track started (demo takes).
