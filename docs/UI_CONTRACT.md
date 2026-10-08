# Nightborn UI ↔ host contract (Pi branch)

**Audience:** UI agent working in worktree `../nightborn-ui` on branch `feat/ui`.  
**Write set:** `public/**` only (plus regenerating `fixtures/sample-surgery.log` if needed).  
**Visual SoT:** [ui-ref/Nightborn_UI.html](./ui-ref/Nightborn_UI.html) and `artifacts/Nightborn_UI/extracted/Frames.dc.html`.

Backend write set is everything else (`src/`, `templates/`, …). Do not edit `src/`.

---

## Base URL

`http://127.0.0.1:${PORT}` — default `PORT=8787`.

Static: `/` → `public/index.html`, `/voice/*` → `public/voice/*`.  
`/mock/<provider>` only when server started with `OFFLINE=1`.

---

## Endpoints

### `POST /api/talk`

Request:

```ts
{ text: string, fixture?: string }  // fixture = filename under fixtures/talk/
```

Response:

```ts
| { kind: "chat"; text: string }
| {
    kind: "job";
    job: {
      skill: string | null;
      intent: string;
      query: string;
      needs: string[];
    };
    outcome: "install" | "reuse" | "denied" | "broken";
    skill: string | null;
    failureCode?: string;
    reply: string;
  }
```

- Synchronous; may take up to ~150s when Pi runs.
- Disable Send + chips while a request is in flight.
- For `denied` / `broken`, show `reply` (host template, not the model).

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
  source?: "live" | "fixture";
  detail?: string;
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
| `News on Microsoft` | Forge (Create) |
| `News on OpenAI` | Reuse (`job.skill: null` → capability match) |
| `Email this news digest to my boss every morning.` | DENIED (tripwire; **exact** string) |

Placeholder input: `Message Nightborn`.

---

## Visual regions → data

| Region | Source |
|--------|--------|
| CHARTER LOCKED + short hash | Every log line's `charterHash` (first 8 hex). Compare to boot line — red if drift. |
| Strip: `charter unchanged since boot · granted ⊆ charter` | Same hash check + union of `caps` on install/reuse ⊆ charter allow-list → `+0 AUTHORITY` |
| `log · N lines` | Total lines seen (or `next`) |
| FORGED | Count of `event === "install"` |
| PIPELINE stages GAP→FORGE→WARDEN→TEST→INSTALL | Events since last `job` (see below) |
| GRAFT 01–04 | Filled by successive `install` lines (`skill` + caps detail) |
| CHARTER GRANTS / NEVER | Static copy from `charter.md` allow/deny lists |
| WORKBENCH reply | `/api/talk` `text` or `reply` |
| SURGERY LOG table | `/api/log` columns: time · event · actor · detail · charter |

Artifact **frame tabs** (Boot…Broken) are mock storyboard only — do not require a frames API.

### Pipeline mapping

After the latest `job` line:

| Log event | Stage |
|-----------|--------|
| `gap` / `matched` | GAP |
| `forge` | FORGE |
| `precheck` / `denied` | WARDEN (`denied` = red) |
| `test` / `broken` | TEST (`broken` = red) |
| `final` / `install` / `reuse` | INSTALL |

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
# POST /api/talk { "text": "…", "fixture": "denied-email.json" }
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
