# Nightborn — Hackathon Spec (Case 03 Frankenstein)
**Agents 0.0.7 · From Dusk Till Dawn · Prague · Thu 8 Oct → Fri 9 Oct 2026**  
**Agenda (official):** doors 16:00 · kick-off 17:30 · planning 18:25 · **build starts 21:00 (+0h)** · code freeze **07:14 (+10.25h)** · **live jury presentations 10:00**  
**Team:** 2 people (Max = dev · Yevhenii = product/UI/demo, **calls Go/No-Go**)  
**Stack:** TypeScript host · single package **Hono + tsx** · ESM skills (`skill.mjs`) · ElevenLabs (pre-rendered WAVs) · **OpenAI** · **HTTP web search: Brave (frozen; Tavily only as fallback)** · optional Apify via REST `fetch` (provider variant, only after `c4-reuse-forged` + Yevhenii Go)  
**Submit:** codebase + 2-min video · **Host:** video first; Render only if video already exported by 06:15  
**Judging:** E2E 35% · track value 25% · tech 20% · originality 10% · **Validation and honest limitations** 10% (official brief)

This doc is the shared source of truth. Treat **Must** / **cut** lines as binding when behind schedule.

---

## 0. Changelog (latest: v3.2.5)

### v3.2.4 → v3.2.5 (re-sync — no architecture change)

1. Restored frozen picks lost in v3.2.4's base: Brave frozen with Tavily fallback only, `env: ["BRAVE_API_KEY"]`; voice ID frozen (§18 #4); Apify only after `c4-reuse-forged` + Yevhenii Go (header, §9, §14, §18 #3 #4).
2. §9 Runner rule restored: ≥2 skills match by capability → no Reuse, `gap` "ambiguous capability match → create"; `baseUrl` always absolute.
3. §14 role split matches `BOARD.md` timing: `/api/talk` fixture path, talk + forge fixtures and the provider curl move to C1; `soul.md` to C2.
4. §16: venue Wi-Fi is the upload path; phone hotspot is the backup.

### v3.2.3 → v3.2.4 (backlog gap decisions — no architecture change; §18 #15–22)

1. `skills/hand_probe/decision.json` = committed seed generated from `src/hash.ts` at C1; the only `decision.json` Warden doesn't write; regenerated on every re-pin; disclosed as Simulated (§3, §6, §7, §9, §17).
2. take0 Reuse via `fixtures/talk/reuse-probe.json` sent with `curl` to `POST /api/talk` (no UI button); fixture-driven `job`/`forge` lines carry `source:"fixture"` (§7, §13).
3. UI dev feed = server run with cwd `staging/ui-dev/`; `OFFLINE` never changes `/api/log` (§13).
4. Live Talk = Max's first C3 card (M3.0), 30-min timebox (§14).
5. `scripts/fresh.ts` (C2) and `src/mock.ts` (C1, conditional) get owners (§14).
6. `BOARD.md` in the §7 layout: written only by Yevhenii, agents read only.
7. `/api/log` `lines` = parsed log objects (§12 shape), never raw strings (§13).
8. Chip B fixture `reuse-company-b.json` uses `job.skill: null`, so Reuse matches by capability (§9, §13).

### v3.2.2 → v3.2.3 (risk decisions — no architecture change; §18 #9–14)

1. Template URL literals absolute; `baseUrl` absolute on stdin; `protected_path` regex unchanged (§8, §9).
2. `validate.ts` flips a **copy** of `charter.md`; the real file is never written (§17).
3. Hire cut; live TTS cut; Apify only after `c4-reuse-forged` + Yevhenii Go, on a branch, merged by +7.5 (§2, §10, §14).
4. "Forge retry" removed from the §5 cut list (already forbidden by §9).
5. `CHARTER_PIN` value committed in `.env.example` with the pinned `charter.md`; both laptops compare the hash at C0 (§6).
6. Committed `.gitignore` incl. video patterns (§7).
7. Frozen: `SEARCH_PROVIDER=brave` (Tavily fallback only); `ELEVENLABS_VOICE_ID` per §18 #4 (§9, §14, §18 #3 #4).

### v3.2.1 → v3.2.2 (polish only — no architecture change)

Five polish packs + wording fixes. No new features, templates, endpoints, or providers.

1. **Reuse contract pack** — `skill.mjs` reads `query` from stdin (never baked in); LLM strings rendered only via `JSON.stringify`; skill name slugified in code; manifest caps fixed per template; deterministic Runner Reuse/Create rule restored (incl. capability fallback); hand skill renamed `hand_probe` (`template:"hand"`) and cut from final video; scan finding→capability table frozen (§8).
2. **DENIED hardening** — tripwire runs on raw text **before Talk**, Talk skipped on match; word-boundary regex; exactly one voiced `denied` line by Warden; `reply` templated from `failureCode`; WAVs only in `public/voice/`; `nodemailer` **not installed**.
3. **Voice playback rules** — first poll silently sets cursor; only lines arriving after page load play, one at a time; audio unlocks on first user gesture anywhere; Voice toggle cut.
4. **Hash stability + reset** — folder hash covers exactly `skill.mjs`, `notes.md`, `manifest.json`; `.gitattributes` adds `skills/** -text`, `templates/** -text`; Reset button cut → `npm run fresh` off camera (rotates log, never truncates).
5. **Validation evidence** — `scripts/validate.ts` → `validation/results.json`; slide = **Works / Simulated / Incomplete**.

Also: contracts made explicit (§9, §13: `decision.json`, skill I/O, Broker/`SEARCH_PROVIDER`, `OFFLINE`, `JUDGE_MODE`, `/api/talk {text, fixture?}`, `caps` log field, timeouts); checkpoints moved to relative hours with per-tag smoke checks; C2 builds chip/fixture buttons + real log wiring; C3 builds fixture-first; take0 uploaded at +4.5; 10:00 live jury plan; kill switch; wireframe cut list + real-company chips; provider/voice/company decisions due **Wed 7 Oct 22:00 (tonight)**.

---

## 1. One-sentence product

Nightborn is a dark junior analyst that **grows skill packages overnight** (Forge) while **authority stays locked** by a hashed charter, a code Warden, and a Broker that holds secrets — more hands, same leash.

---

## 2. Non-goals (explicitly cut)

- Long chat memory / retrieval / RAG (Talk keeps a sliding window of last 5 turns only)
- Hire / Sokosumi marketplace (cut, no exception)
- Dual DBs, migrations, memory decay
- Perfect sandbox / containers
- LLM-as-Warden
- LLM-written self-tests as the only gate
- Polished multi-tab dashboard
- **Next.js / monorepo / SSE**
- **Apify SDK; Apify as primary or only demo path**
- **Forge writing free-form JS** (params-only; code renders templates)
- **A third template** (only `http` and `email_send`; Apify is a provider variant of `http`, not a template)
- **Live TTS** (cut; pre-rendered WAVs are the only audio path)
- **Showing a hand-written skill on the final video** as any beat
- **Judge-facing word "Adopt"** (public term = Forge only)
- **Table output, date filtering, URL-reader skill** (wireframe chips implying these are removed)
- **UI Reset button, UI Voice toggle** (risks, not features)
- **Live Broken on video** (Broken proven by `validate.ts`, shown on slide)
- **Installing `nodemailer`** (scan reads source text only)

---

## 3. Glossary

| Term | Meaning |
|------|---------|
| Talk layer | Chat face; LLM context = invariant + optional snapshot + last 5 turns + current user; outputs chat text **or** typed Job; never installs; never writes `reply` for denied/broken |
| Job | Structured task for the workshop |
| **Tripwire** | Runner code that runs on **raw user text before Talk**; on match, skips Talk and builds the fixed `email_send` Job |
| Runner | Applies tripwire; chooses Reuse vs Create by deterministic rule (§9); orchestrates pipeline; appends log lines as each step happens |
| Skill package | Folder: `skill.mjs` + `notes.md` + `manifest.json` (+ `decision.json` after Install) |
| **Forge** | LLM fills **params** only; host code renders template files into staging (no free-form code). The one public mechanism for creating skills |
| Reuse | Run an already-installed skill (query passed at runtime on stdin) |
| Staging | `staging/<runId>/` inside repo (not `os.tmpdir`); wiped on DENIED or Broken |
| Warden | Deterministic code checks; named failure codes; sole writer of `decision.json` (except the committed `hand_probe` seed, §7) and of `denied` lines |
| Charter | Rulebook (`charter.md`); hashed at boot |
| Broker | Holds API keys; grants only what the provisional PRE grant or `decision.json` allows |
| Surgery log | Append-only JSONL; UI tails it |
| **Genome** | Cards or plain rail from log events (not a force graph) |
| `hand_probe` | Hand-written skill (`template:"hand"`) used only for C1 / take0 Broker+hash proof; never on final video |
| Outcomes | **Install** · **Reuse** · **DENIED** (policy) · **Broken** (forge/test fail) |

---

## 4. Pipeline (v3.2.2 — tripwire before Talk)

```
YOU → Runner.tripwire(raw text)   /\b(e-?mail\w*|smtp|sms)\b/i
        ├─ match → skip Talk → fixed Job {template:"email_send", needs:["notify:email"]}
        │            → log: forge (detail "fixed template, no LLM")
        │            → Warden PRE → DENIED capability_not_allowed + denied.wav · wipe staging
        │            → reply = template("capability_not_allowed")
        └─ no match → Talk (soul.md)
                        ├─ chat → reply (no voice)
                        └─ job  → Runner rule (§9)
                                   ├─ REUSE → folder hash + charter hash vs decision.json
                                   │          Broker grants decision.env → run(query) → Talk
                                   │          log: matched → reuse
                                   └─ CREATE → log: gap → Forge (params → render http template)
                                              → Warden PRE (scan · caps · charter)
                                                  ├─ deny  → DENIED + voice · wipe staging
                                                  └─ allow → Broker (provisional grant) → Test
                                                              ├─ fail → Broken + voice · wipe staging
                                                              └─ pass → Warden FINAL (re-hash)
                                                                         ├─ deny  → DENIED + voice
                                                                         └─ allow → Install (+ install.wav)
```

- **Gap event:** `gap` with `detail: "no installed skill covers <intent> → create"` (or `"ambiguous capability match → create"`, §9 "Runner rule" step 4); `matched` with `detail: "by name"` or `"by capability"`.
- **Broker** never owns policy: reads only the in-memory provisional PRE grant (Test time) or `decision.json`.
- **Every log line** carries `charterHash`, `actor`, `skill`, `decision`, `failureCode?` (§12).
- Runner **appends each line when the step happens** (not batched at end of the synchronous request) so the UI pipeline lights up live.

---

## 5. Must / should / cut

### Must (never cut)
1. Warden check chain + named failure codes
2. Charter hash at boot; refuse start on pin mismatch; stamp every log line
3. Append-only `surgery.log` JSONL (rotated by `npm run fresh`, never truncated)
4. Talk never installs; only typed Jobs reach Runner (plus tripwire Jobs)
5. Outcomes DENIED / Broken / Install / Reuse; demo never hard-crashes
6. Child-process skill run + timeout + stripped env (`execFile(process.execPath, …)`, stdin closed)
7. Per-run folder hash check on Reuse
8. Warden FINAL re-hash vs PRE
9. **Deterministic DENIED**: tripwire (before Talk) + `email_send` + Warden `capability_not_allowed`; exactly one voiced `denied` line, `actor: warden`
10. **Pre-rendered WAVs primary**; play only lines arriving after page load; unlock audio on first user gesture
11. **Params-only Forge**; LLM strings rendered only via `JSON.stringify`
12. **Runner-owned fixed test schema** per template
13. **Visible authority proof** — strip: "charter unchanged since boot · granted ⊆ charter", derived from log `charterHash` + `caps`
14. **DENIED built before Forge**; take0 by +4.25h, uploaded by +4.5h
15. **Deterministic Reuse rule** (§9) + runtime `query` via stdin
16. **`scripts/validate.ts`** results on the validation slide

### Should (if time)
- TS-compiler static scan (~50-line walk); fallback regex + manifest allowlist
- Genome cards + pipeline stage tint (else plain rail)
- Graft slots filled from `install` lines
- Install / Broken WAVs

### Cut first → last when behind
Render → Node `--permission` → SSE / Next → Apify (any form) → specimen art → graft lines → stage animation → FORGED counter → genome cards (plain rail OK)

---

## 6. Charter (frozen capability enum)

**Allowed:** `net:fetch` · `llm:call` (via Broker) · `fs:read_own` (skill folder only)

**Denied:** `notify:email` · `budget:write` · `charter:write` · `secrets:read` · `fs:write_own` (would drift folder hash)

Plus deny: `eval` / `new Function` / dynamic `import()`; escaping the skill folder; touching `charter.md` / broker paths / secrets on disk.

Capability enum lives in a **fenced block inside `charter.md`** (hashed surface).

**Hash recipe:**
```
sha256("nightborn-charter-v1\n" + toLF(stripBOM(bytes)))
```
Pin in `.env` as `CHARTER_PIN`; the same value is committed in `.env.example` (a hash, not a secret) in the same commit as the pinned `charter.md`. `charter.md` ends with exactly one LF and reaches the other laptop only via git; at C0 both laptops boot and compare the 8-hex short hash. Any later charter change = Yevhenii Go + new pin + regenerated `skills/hand_probe/decision.json` in the same commit. On mismatch: log `boot` / `deny` / `charter_pin_mismatch` with computed hash (**no voice** — no browser at boot), then `exit(1)`.

**Display format:** short hash = first **8 hex chars, no separator** (e.g. `a3f9c21e`) everywhere — header, log tail, video; full hash in tooltip.

**.gitattributes** (committed):
```
charter.md   text eol=lf
*.json       text eol=lf
skills/**    -text
templates/** -text
*.wav        binary
```

---

## 7. Repo layout (single package)

```
nightborn/                          # "type":"module" · Hono + tsx
  src/
    server.ts talk.ts runner.ts forge.ts warden.ts
    broker.ts exec.ts hash.ts log.ts charter.ts mock.ts   # mock = OFFLINE provider routes
  templates/
    http/                           # skill.mjs.tpl · notes.md.tpl · manifest.json.tpl (per provider key name)
    email_send/                     # fixed files, LLM-free; imports nodemailer (never installed, never run)
    schemas.ts                      # Runner-owned zod schemas per template
  public/
    index.html                      # vanilla JS; polls /api/log
    voice/denied.wav install.wav broken.wav   # ONLY location for WAVs
  scripts/
    validate.ts                     # → validation/results.json
    fresh.ts                        # npm run fresh
  skills/                           # installed packages (hand_probe + forged)
  staging/<runId>/                  # inside repo; wiped on DENIED/Broken
  fixtures/
    talk/                           # forge-company-a.json, reuse-company-b.json, denied-email.json, reuse-probe.json (take0 only)
    forge/                          # pull_company_news.json (param replay)
    http/                           # news-<slug>.json (provider response shape)
    sample-surgery.log              # every event type, UI dev mock
  validation/results.json
  charter.md  soul.md  surgery.log  .gitattributes  .gitignore  .env.example  README.md
  BOARD.md                          # task board: written only by Yevhenii; agents read only
```

**Dependencies:** `typescript@5.9.3` (**pinned, in `dependencies`** — Warden needs it at runtime; 7.x lacks `createSourceFile`), `zod@^4`, `openai`, `hono`, `@hono/node-server`, `tsx`. **Do not install `nodemailer`** — the scan reads source text; an accidental run dies with `ERR_MODULE_NOT_FOUND` → Broken.

**Scripts:** `npm start` = `tsx src/server.ts` (no watch mode for takes) · `npm run fresh` · `npm run validate`.

**`.gitignore`** (committed): `.env` · `node_modules/` · `staging/` · `video/` · `*.mp4` · `*.mov` · `.DS_Store`. Never ignore `public/voice/*.wav`, `surgery*.log` or `validation/`.

**Per skill folder** (`skills/<name>/`, name `^[a-z0-9_]+$`, path-traversal guarded):
```
skill.mjs       # plain ESM; stdin JSON in → JSON stdout; exit 0
notes.md
manifest.json   # name, template, capabilities[], outputSchema (display only)
decision.json   # ONLY written by Warden on Install — sole exception: hand_probe's committed seed (§9)
```

**`npm run fresh`** (off camera, before every take): rotates `surgery.log` → `surgery.<ts>.log`; removes forged skills and `staging/*`; keeps `hand_probe` only if the take needs it (take0); restore it with `git checkout skills/hand_probe`, never commit its deletion. UI must then reset its cursor (§13).

---

## 8. Manifest + static scan

Warden parses `skill.mjs` with the TypeScript compiler API:
`ts.createSourceFile('skill.mjs', src, Latest, true, ScriptKind.JS)`, ~50-line walk.

**Finding → capability (frozen):**

| Finding | Capability |
|---|---|
| `fetch(` / `http` / `https` / `undici` / `axios` | `net:fetch` |
| literal `process.env.TAVILY_API_KEY` / `BRAVE_API_KEY` / `APIFY_TOKEN` | `net:fetch` |
| literal `process.env.OPENAI_API_KEY` / `openai` import | `llm:call` |
| any other `process.env` access (incl. computed) | `secrets:read` |
| `nodemailer` / `smtp` import or `require` | `notify:email` |
| fs write calls | `fs:write_own` |
| fs read calls | `fs:read_own` |
| `eval`, `new Function`, `CallExpression` on `ImportKeyword` | **auto-deny** `forbidden_construct` |
| string literal `/charter\.md|\.\.\/|\.env|broker|^\//` | **deny** `protected_path` |

Required caps = union of scan findings + manifest claims + Job `needs`. Any cap outside the charter allow-list → `capability_not_allowed`. Manifest claims ≠ scan findings → `manifest_mismatch`.

Templates (incl. `email_send`) contain no string literal starting with `/` or matching any `protected_path` pattern: every URL literal is absolute and `baseUrl` arrives absolute on stdin. The regex is never loosened.

**Abort ladder:** scan 45 min over timebox → regex + manifest allowlist (same table, regex form).

**Honest limit:** static scan ≠ sandbox. Real boundary = subprocess + timeout + least-privilege env.

---

## 9. How skills run — contracts (frozen)

### Execution
```ts
const c = execFile(process.execPath, [absSkillPath], {
  cwd: skillDir,
  env: { ...brokerGrantedKeys /* Windows: + SYSTEMROOT */ },
  timeout: T, killSignal: 'SIGKILL', maxBuffer: 1 << 20,
}, cb);
c.stdin.end(JSON.stringify(input));   // MUST close stdin or child hangs until T
```
Overrun → Broken `timeout`. Templates use global `fetch`, no SDKs (exception: `email_send` imports `nodemailer` as a scan target only).

### Skill I/O
```ts
// stdin
{ query: string, baseUrl?: string, max?: number }
// stdout (exit 0)
{ items: [{ title: string, url: string, date?: string }] }
```
`query` is **always a runtime input** — never rendered into `skill.mjs`. `baseUrl` is set by Runner only when `OFFLINE=1`, always absolute.

### Forge (params → render)
LLM returns `{ name, purpose, query, capabilities }`:
- `name` → slugified in code to `^[a-z0-9_]+$`; suffix `_2` if taken.
- `purpose` → `notes.md` / `manifest.json` only, via `JSON.stringify`.
- `query` → used **only as the Test input**; never rendered into code.
- `capabilities` → **logged only**; manifest caps = template's fixed set (`http` → `["net:fetch"]`).
No free-form JS. No Forge retry (fail → Broken `forge_invalid`).

### Runner rule (deterministic, no LLM)
1. Tripwire match → `email_send` Job (Talk skipped).
2. `job.skill` names an installed skill → **Reuse** (`matched`, detail `by name`).
3. Else if **exactly one** installed skill with `decision.template === "http"` and `needs ⊆ decision.capabilities` → **Reuse** (`matched`, detail `by capability`). Empty `needs` for a search intent ⇒ `["net:fetch"]`. `hand_probe` (`template:"hand"`) is never matched by capability.
4. Else if **two or more** installed skills would match by capability → **no** capability Reuse; fall through to Create and log `gap` with `detail: "ambiguous capability match → create"` (cannot happen in the one-search-skill demo; written so the rule is complete).
5. Else → **Create** (`gap`).

### Test (Runner-owned)
Input `{ query: forge.query }`. Fixed zod schema per template (`{items:[{title,url,date?}]}`) + content check **≥1 item with non-empty `url`**. Manifest JSON schema is display only.

### Folder hash
`sha256` over **exactly `skill.mjs`, `notes.md`, `manifest.json`** (sorted), each line `relpath \0 sha256(bytes) \n`. All other files ignored. PRE stores H1; FINAL recomputes → `hash_mismatch` on drift; Reuse checks folder hash **and** charter hash against `decision.json`.

### decision.json (Warden, on Install only)
```ts
{ skill, template: "http" | "hand", provider: "tavily" | "brave" | "apify" | null,
  folderHash, charterHash, capabilities: ["net:fetch"], env: ["BRAVE_API_KEY"], decidedAt }
```
Exception: `skills/hand_probe/decision.json` is a committed seed generated from `src/hash.ts` at C1 (never hand-typed; writes no log line; `env` = the key for the chosen `SEARCH_PROVIDER`). It is regenerated on every re-pin (§6) and disclosed as Simulated (§17).

### Broker
- `SEARCH_PROVIDER=brave|tavily` (env; frozen `brave`, `tavily` only as fallback) picks the one key `net:fetch` grants: `TAVILY_API_KEY` or `BRAVE_API_KEY`. `APIFY_TOKEN` only when `provider === "apify"`. `llm:call` → `OPENAI_API_KEY`.
- Test time: grants from Warden's in-memory provisional PRE grant. Reuse: grants exactly `decision.env`. Anything else reads `undefined`.

### Provider request shapes
- **Tavily (fallback only):** `POST https://api.tavily.com/search` · header `Authorization: Bearer tvly-…` · body `{query:"<query> news", topic:"news", time_range:"week", max_results:5, include_published_date:true}` → map `results[].{title, url, published_date→date}`.
- **Brave (frozen default):** `GET https://api.search.brave.com/res/v1/news/search?q=…&count=5&freshness=pw` · headers `X-Subscription-Token`, `Accept: application/json` → map `results[].{title, url, page_age→date}`. Use news endpoint, not `web/search`.
- **Apify (optional; only after `c4-reuse-forged` + Yevhenii Go, §14):** REST `run-sync-get-dataset-items` via `fetch`, `maxItems: 3`, same output mapping.

### OFFLINE mode
`OFFLINE=1` → Runner passes absolute `baseUrl` = `http://127.0.0.1:<PORT>/mock/<provider>` (Hono route), which serves `fixtures/http/news-<slug>.json` in the **provider's response shape**. Subprocess and `fetch` stay real. Log lines carry `source:"fixture"`. HN Algolia (`hn.algolia.com/api/v1/search?query=…`) is an optional third fallback only.

### Timeouts
| Where | Limit |
|---|---|
| `fetch` inside skill | `AbortSignal.timeout(6000)` |
| `execFile` T — http | 15 s |
| `execFile` T — apify | 120 s |
| OpenAI client | `timeout: 30_000`, `maxRetries: 1` |
| `POST /api/talk` | ≤150 s (server allows 300 s) |
| UI fetch | no abort; spinner; Send/chips disabled while pending |

### Env names (`.env.example`)
`CHARTER_PIN` · `OPENAI_API_KEY` · `SEARCH_PROVIDER` · `TAVILY_API_KEY` | `BRAVE_API_KEY` · `APIFY_TOKEN?` · `ELEVENLABS_API_KEY` · `ELEVENLABS_VOICE_ID` · `JUDGE_MODE` · `OFFLINE` · `PORT`

---

## 10. Talk layer + soul + voice

### Talk — flat structured output (OpenAI)
```ts
{ kind: "chat" | "job", text: string,
  job: { skill: string | null, intent: string, query: string, needs: string[] } | null }
```
Use `.nullable()`, never `.optional()` (zodTextFormat rejects it). Never writes `skills/`. **Not called** when the tripwire matches.

### Context assembly (fixed order)
1. **Invariant:** main system prompt (role, schema rules, "never install / only chat or typed Job") + full `soul.md`.
2. **Dynamic snapshot (optional, ≤ ~20 lines):** full capability enum; installed skill names + one-liners; last DENIED `failureCode`.
3. **History:** last **5 turns** of user/assistant chat text only (no log, Job JSON, test output).
4. **Current user message**, last.

### JUDGE_MODE
`JUDGE_MODE=1` swaps **only LLM text** (Talk + Forge params). Fixture file: `{ match: "<normalised prompt>", talk: {…}, forge?: {…} }`, indexed at boot. Normalise = trim + lowercase + collapse whitespace. Miss → live call, `source:"live"`. Warden / Broker / subprocess / hash / log / UI stay live. **Disclose if used.**

### Replies
- `install` / `reuse`: Talk may phrase the result summary.
- `denied` / `broken`: `reply` comes from a **template keyed on `failureCode`** — never the LLM. E.g. `capability_not_allowed` → *"I can build hands for that. I'm not allowed to use them."*

### soul.md
Dark creature / junior analyst: short answers, grows hands, never begs for more permissions, acknowledges the leash.

### Voice (ElevenLabs → WAV)
- **Primary path:** `public/voice/{denied,install,broken}.wav`, rendered **Wed 7 Oct (tonight)**; hard deadline +1.5h.
- Browser plays the WAV named in a log line's `voice` field — **only for lines arriving after page load** (first poll sets the cursor silently), one at a time via a queue.
- Audio unlocks on the **first user gesture anywhere** (Send, chip, keydown).
- Live TTS: cut. WAVs are the only audio path.
- No Voice toggle in UI (static "VOICE · WAV" indicator).

---

## 11. Deterministic DENIED demo (email trap)

**Prompt freeze (byte-exact, also the chip text):** *"Email this news digest to my boss every morning."*

**Guarantees (code, not LLM luck):**
1. **Runner tripwire before Talk** on raw user text: `/\b(e-?mail\w*|smtp|sms)\b/i` → Talk skipped; any Talk Job discarded; fixed Job `{ template: "email_send", needs: ["notify:email"] }`. Exactly one outcome.
2. **email_send** copied to `staging/<runId>/`: fixed `skill.mjs` importing `nodemailer` + manifest claiming `notify:email`. Logged as `forge` with `detail: "fixed template, no LLM"`. Never runs; `nodemailer` not installed.
3. **Warden PRE** → `capability_not_allowed` from three triggers (Job needs, manifest claim, scan `nodemailer → notify:email`). Staging wiped. **Exactly one** line:
   `{event:"denied", actor:"warden", decision:"deny", failureCode:"capability_not_allowed", voice:"voice/denied.wav", caps:["notify:email"], detail:"triggers: job_needs, manifest, scan:nodemailer"}`. No other line carries `voice`.
4. `reply` = failureCode template (§10).

**Disclose:** tripwire = keyword match; asks without a keyword ("send it to my boss's inbox", "text me") depend on Talk and are **not guaranteed** — listed as a known miss.

Backup: email chip / `fixture:"denied-email.json"` hits the same Warden path.

Budget / charter-rewrite prompts are not traps (soul chat only).

---

## 12. Surgery log event

```json
{
  "ts": "ISO-8601",
  "actor": "talk|forge|warden|runner|broker|user|test",
  "event": "boot|job|gap|forge|matched|precheck|test|final|install|reuse|denied|broken",
  "skill": "pull_company_news|null",
  "decision": "allow|deny|pass|fail",
  "failureCode": "…",
  "charterHash": "abc…",
  "caps": ["net:fetch"],
  "voice": "voice/denied.wav",
  "source": "live|fixture",
  "detail": "optional short string"
}
```

- **Optional fields:** `caps` (on `precheck` / `install` / `reuse` / `denied`), `voice`, `source`, `detail`.
- On a PRE deny, Warden writes the single `denied` line (no separate `precheck` deny line).
- `voice` only on: the one `denied` line, `install`, `broken`.
- `charter_pin_mismatch` has **no voice** (boot, no browser).

### failureCode enum (frozen)
**Policy → DENIED + voice:** `charter_pin_mismatch` (no voice, exit) · `capability_not_allowed` · `forbidden_construct` · `protected_path` · `secret_in_file` · `manifest_mismatch` · `invalid_skill_name` · `hash_mismatch`  
**Build/run → Broken:** `forge_invalid` · `test_exit_nonzero` · `timeout` · `schema_invalid`

**Authority:** every line carries the same `charterHash` since boot. UI must not invent state the log doesn't have.

---

## 13. UI + merge contract

### Merge contract (two endpoints only)
1. `POST /api/talk` `{ text, fixture? }` (`fixture` = filename in `fixtures/talk/`) →  
   `{ kind:"chat", text }` **or**  
   `{ kind:"job", job, outcome:"install"|"reuse"|"denied"|"broken", skill, failureCode?, reply }`  
   Synchronous, ≤150 s.
2. `GET /api/log?since=<line>` → `{ lines, next }`; `lines` = parsed log objects (§12 shape), never raw strings. Poll every 1 s. If `next < since` (log rotated / server restarted fresh) → reset cursor to 0 **and** treat as first poll (no voice replay).

Static: `/` → `public/index.html`, `/voice/*` → `public/voice/*`. Dev-only: `/mock/<provider>` when `OFFLINE=1`.

- Any `job` / `forge` line produced from a `fixtures/talk/` file (JUDGE_MODE hit or `fixture` param) carries `source:"fixture"`.
- `OFFLINE` never changes what `/api/log` serves. **UI dev feed:** run the server with cwd `staging/ui-dev/` holding a copy of `charter.md` and `fixtures/sample-surgery.log` saved as `surgery.log` (cwd rule, §17); `public/` and `.env` resolve from the repo root. Never on a take.

### Client rules
- First poll sets cursor; voice plays only for newer lines; one at a time.
- Unlock audio on first gesture anywhere.
- After a server restart, keep polling with the same cursor; **never reload the page mid-take** (drops audio unlock).
- Send and chips disabled while a `/api/talk` request is pending.

### Wireframe → 10h cut list
| Region | Tier | Source / rule |
|---|---|---|
| Header: CHARTER LOCKED + `a3f9c21e` + **"charter unchanged since boot · granted ⊆ charter"** | must | log: every line's `charterHash` == boot line's; else red |
| Surgery log tail | must | log |
| Workbench reply + chips + input/Send | must | Talk response; chips = static strings → `/api/talk` (fixture-backed in judge mode) |
| GRANTS (teal) / NEVER (red) lists | must | static, copied from `charter.md`; NEVER shows **all 5** denied caps |
| **AUTHORITY +0 · granted ⊆ charter** | must | log: union of `caps` on install/reuse lines minus charter allow-list (= +0) |
| Pipeline status pill + 5 stage cards | should | log: latest event since last `job`: gap/matched→GAP · forge→FORGE · precheck→WARDEN · test→TEST · final/install→INSTALL · reuse→INSTALL · denied→WARDEN red · broken→TEST red |
| Graft slots | should | filled only by `install` lines (skill name); fallback plain "FORGED: name" list |
| **+N FORGED** (was "+N SKILLS") | should | count of `install` lines (`actor: warden`) |
| "log · N lines" (was "1 events") | chrome | line count |
| Clock | chrome | browser clock (real time) |
| "CASE 03" label (was "SPECIMEN 03") | chrome | static |
| Specimen sphere, bolts, circular text | chrome | static SVG; first to cut |
| Voice toggle | **cut** | static "VOICE · WAV" indicator |
| Reset button | **cut** | `npm run fresh` off camera |

**Chips (final):**
1. `News on <Company A>` (Forge beat)
2. `News on <Company B>` (Reuse beat; fixture `reuse-company-b.json` has `job.skill: null` → Reuse by capability, §9 "Runner rule" step 3)
3. `Email this news digest to my boss every morning.` (byte-exact)

Company A/B = two **real** companies the chosen provider returns ≥3 recent items for (decided tonight). Removed: "Kestrel Air — 2025 only, as a table", "Read northwind.example/careers".

**UI cut order if tight:** Reset + Voice toggle (now) → specimen art → graft lines → stage animation → FORGED counter. **Never cut:** authority strip, log tail, workbench, DENIED badge + audio.

---

## 14. Plan — checkpoints (relative hours)

**Build starts 21:00 official (+0h); 18:25–21:00 is planning, no code. Freeze 07:14 (+10.25h).** Slack goes to C3, never to features. DENIED before Forge. Take0 at +4.25h.

### Pre-event (Wed 7 Oct, by 22:00 tonight)
- `SEARCH_PROVIDER=brave` frozen (§18 #3) — confirm key; pick Company A/B.
- `ELEVENLABS_VOICE_ID` frozen (§18 #4); render all three WAVs into `public/voice/`.
- Throwaway spikes OK (brief states no pre-written-code rule — **confirm at kick-off**): flat Talk schema on ~10 prompts incl. exact chips; one provider curl per company.

### Checkpoints
| Checkpoint | Clock (abs / rel) | Must be true — smoke check (≤2 min) | If red → backup |
| --- | --- | --- | --- |
| **C0** charter pin + log | 21:30 / +0.5 | One-byte flip of `charter.md` → `exit(1)` + `charter_pin_mismatch`; `boot` line with `charterHash` | +0.75: one-line check, pin in `.env`. C0 never slips |
| **C1** `hand_probe` Reuse + Broker | 23:30 / +2.5 | `hand_probe` via `execFile` (stdin closed), timeout, stripped env; skill byte flip → `hash_mismatch`; ungranted key reads `undefined`; one provider curl OK | +2.75: `OFFLINE=1` fixtures. Broker red ≠ C1 red if `undefined` proof holds. Never block C2 on Broker polish |
| **C2** DENIED + voice + wiring | 01:00 / +4.0 | Email chip → tripwire (Talk skipped) → `email_send` → Warden → exactly one `denied` line `actor:warden` → WAV plays once. **Chips/fixture buttons built; UI on real `/api/log`** | +4.25: Warden = manifest allowlist + regex; WAV only |
| **C2.5** take0 | 01:15 / +4.25 | Raw screen + audio: boot pin, `hand_probe` Reuse, DENIED → `video/take0.mp4`. **Upload unlisted by +4.5 via phone hotspot**; dry-run submission (repo visibility, README skeleton, video link) | None — this take is the backup |
| **C3** Forge → PRE → Test → FINAL → Install | 03:30 / +6.5 | **Build order:** fixture params → PRE → Test → FINAL → Install first (target +5.5), then wire LLM params. Smoke: `install` line, `decision.json`, FINAL = PRE | +6.0: stay on forge fixture through the real pipeline; disclose |
| **C4** Reuse forged + genome | 04:00 / +7.0 | `npm run fresh`, forge Company A, Ctrl-C, `npm start` → boot re-hash → Company B logs `matched` + `reuse`, no `forge`; UI cards from real log | +7.25: plain log rail + fingerprint |
| **C5** take1 | 04:30 / +7.5 (cap 05:00) | Full 2-min script (§15); `npm run validate` green; upload unlisted | Ship take0 + voice-over |
| **C6** freeze polish | 05:00–07:14 | Only fixes to a broken script step. Final take ~06:15, **upload started by 06:40 (+9.67)**, done 07:00, tag 07:10 | Submit take1 |

**Tags:** `c0-pin` · `c1-reuse` · `c2-denied` · `c2.5-take0` · `c3-install` · `c4-reuse-forged` · `c5-take1` · `c6-freeze`. Tag after that checkpoint's smoke check passes; **push to remote on every tag**; branch before risky work. Full script runs only at C5 and C6.

### Role split
- **Pre-event:** Yevhenii = provider/voice/company picks, WAVs, chip text · Max = spikes
- **C0:** Max = pin, JSONL, endpoint stubs · Yevhenii = charter text + enum by 21:15, `sample-surgery.log`
- **C1:** Max = runner exec, Broker, `hand_probe` (+ §9 decision seed), hash; `mock.ts` now if live provider fails, else before the jury, `/api/talk fixture` path (C1 smoke driver) · Yevhenii = UI shell (strip, log tail, workbench, voice queue) on sample log, talk + forge fixtures, provider curl
- **C2:** Max = tripwire, Warden PRE, `email_send`, failureCode reply templates, `fresh.ts` (before take0) · Yevhenii = chips + fixture buttons, `soul.md`, point UI at real log, rehearse, record + upload take0
- **C3:** Max = live Talk (`talk.ts`, M3.0: first C3 card, 30-min timebox, done by +4.75; Talk is not Forge params; Yevhenii calls the +5.0 row) → Forge, Test, FINAL, Install · Yevhenii = stage tint, graft slots, script, validation slide, README
- **C4:** joint smoke check (not a wait)
- **C5–C6:** Yevhenii records/edits/uploads · Max bugfixes + `validate.ts`

### Abort ladder (relative; +0 = 21:00)
| If | By | Then |
| --- | --- | --- |
| WAVs not rendered | +1.5 | Render now (no live TTS) |
| Live Brave fails (Tavily fallback too) | +2.75 | `OFFLINE=1` fixtures; HN Algolia optional third |
| TS scan over timebox | +45 min into it | Regex + manifest allowlist |
| Talk misses Job on 3 rehearsed prompts | +5.0 | Chips POST `fixture` (built at C2); Talk still chats |
| Forge not passing Test | +6.0 | Stay on forge fixture through real pipeline; disclose |
| Any new feature | +7.0 | Forbidden (sole exception: Apify row) |
| Apify | +7.0–7.5 only | Only if `c4-reuse-forged` is tagged and Yevhenii says Go: one 30-min try on branch `try/apify` as `provider:"apify"`; merge only if C4 smoke still passes by +7.5, else a limitations line |
| Genome not rendering | +7.25 | Plain log rail + badges |
| Render | +9.25 (06:15) | Cut unless final video exported |
| Upload | start +9.67 (06:40) | Phone hotspot (tested at +4.5) |

### Go/No-Go
- **Yevhenii calls it.** Phone alarms at every checkpoint time. Yevhenii never debugs backend >15 min.
- Green = smoke check passes → tag, push, continue. Red = 15 min grace → backup. If both are debugging when the alarm fires: stop, call it.
- Any single bug >30 min → backup.
- **Kill switch:** submit the newest take that is fully exported, uploaded and watched end-to-end once. Order: final → take1 → take0 + voice-over. No re-records after 06:40.

### After freeze (Fri 9 Oct)
- 07:14–08:00 submit check, sleep/food.
- **08:00–09:30 rehearse the 10:00 live jury presentation:** play video; live DENIED only if smoke check passes with `OFFLINE=1`; validation slide; 2 likely questions each (scan ≠ sandbox, "is the gap just a lookup?").

---

## 15. Demo script (2:00, burned-in subtitles)

| Time | Beat |
|---|---|
| 0:00–0:12 | **Intro** — creature, CHARTER LOCKED `a3f9c21e`, authority strip. Optional 5 s: one-byte charter flip → `exit(1)` → revert |
| 0:12–0:50 | **Forge → Install** — chip A → GAP→FORGE→WARDEN→TEST→INSTALL; graft fills; `install` line; FINAL = PRE. Forge latency = **disclosed jump cut** ("⏩ cut ~Ns real time — uncut log in repo") |
| 0:50–1:12 | **Restart + Reuse** — Ctrl-C, `npm start`, same hash on new `boot` line; chip B → `matched` + `reuse`, no `forge` (uncut) |
| 1:12–1:37 | **Email DENIED + voice** — exact prompt → Warden red → `denied.wav`; zoom on `actor:warden · capability_not_allowed` (uncut) |
| 1:37–2:00 | **Validation slide** (Works / Simulated / Incomplete) → close on authority strip |

`hand_probe` is **not** in the final video (take0 only). Do not show hand-written skill creation as growth.

---

## 16. Hosting notes

- Submission artifact = **local video** + public repo (visibility confirmed at kick-off).
- Render only if video exported by 06:15; otherwise cut.
- Render free disk is ephemeral → genome resets; say so if hosted.
- Upload over venue Wi-Fi; phone hotspot = backup if Wi-Fi is slow or blocks the upload (hotspot path tested at +4.5, §14 C2.5). Export 1080p H.264, ~100–150 MB.

---

## 17. Validation + honest limitations (slide: three columns)

**Validation evidence** = `npm run validate` → `validation/results.json`:
- charter byte flip → `exit(1)` + `charter_pin_mismatch`. `validate.ts` writes a flipped copy to `staging/validate-<ts>/charter.md` and boots `src/server.ts` with that dir as cwd; the real `charter.md` is never written. The server resolves `charter.md` and `surgery.log` from `process.cwd()`.
- skill byte flip → `hash_mismatch`
- ungranted key → `undefined`
- skill returning `{}` → Broken `schema_invalid`
- DENIED on trigger phrasings (exact prompt, "e-mail me the digest", "SMS me when it changes", "send it via SMTP", "Email it to the team") → each exactly one `actor:warden` `denied` line
- 0 false positives on chip A, chip B, "mechanisms of <Company A>"
- **Known miss** reported, not hidden: "send it to my boss's inbox" (no keyword → depends on Talk)

| Works | Simulated | Incomplete |
|---|---|---|
| Charter pin + hash on every line | Anything logged `source:"fixture"` (OFFLINE HTTP, forge replay, Talk replay via chips / judge mode) — subtitled when shown | Forge = params into one http template; no new code shapes |
| Warden code DENIED (`actor:warden`) | Forge latency jump-cut on video; `hand_probe`: hand-written probe, seeded `decision.json` (validate + take0 only) | Gap = registry lookup of Talk's proposed skill / capability |
| Params-only Forge → Runner test → FINAL = PRE → Install | | Tripwire = keyword match; known miss listed |
| Reuse after restart with folder + charter hash | | Static scan ≠ sandbox; no network jail (`--permission` cut) |
| Broker: ungranted key = `undefined` | | `net:fetch` is coarse — can reach email APIs |
| Results file above | | Hire / marketplace not in MVP; hosted FS may reset |

---

## 18. Open decisions — FREEZE

| # | Decision | When | Pick |
| --- | --- | --- | --- |
| 1 | Capability enum | Frozen | §6 |
| 2 | DENIED prompt + code | Frozen | §11 (tripwire before Talk, new regex) |
| 3 | Search provider | Frozen (Wed 7 Oct) | **Brave** (`SEARCH_PROVIDER=brave`, news endpoint); Tavily only if Brave fails ≥3 items in <5 s for both companies. None live → `OFFLINE` fixtures. Apify only per #11 / §14 |
| 4 | `ELEVENLABS_VOICE_ID` | Frozen (Wed 7 Oct) | **`JgMBD2CZ0VSURf6BgyOt`**; DENIED line must be understood on **one play through laptop speakers**, <4 s; render all WAVs immediately |
| 5 | Repo shape | Frozen | Single package Hono + tsx + `public/index.html` |
| 6 | Talk model | Frozen | OpenAI structured outputs, flat schema; no second provider |
| 7 | Demo companies A/B | **Tonight** | Two real companies returning ≥3 recent items from chosen provider; save as `fixtures/http/news-<slug>.json` |
| 8 | Repo visibility | Kick-off | Ask organizers; default public |
| 9 | protected_path vs URLs | Frozen | Templates use absolute URL literals only; `baseUrl` absolute on stdin; regex unchanged (§8, §9) |
| 10 | Charter flip in validate | Frozen | Flipped copy in `staging/validate-<ts>/`, booted with that cwd; real `charter.md` never written (§17) |
| 11 | Post-+7.0 work | Frozen | Hire cut; live TTS cut; Apify only after `c4-reuse-forged` + Yevhenii Go, branch, merge by +7.5 (§14) |
| 12 | Forge retry | Frozen | Not a cut item — forbidden by §9; removed from §5 cut list |
| 13 | CHARTER_PIN sync | C0 | Pin committed in `.env.example` with pinned `charter.md`; one trailing LF; both laptops compare 8-hex hash at C0 (§6) |
| 14 | Ignored files | Frozen | `.gitignore`: `.env` `node_modules/` `staging/` `video/` `*.mp4` `*.mov` `.DS_Store`; never WAVs/logs/validation (§7) |
| 15 | hand_probe decision.json (G1) | Frozen | Committed seed from `src/hash.ts` at C1; regenerated on re-pin; Simulated on slide (§7, §9, §17) |
| 16 | take0 Reuse trigger (G2) | Frozen | `fixtures/talk/reuse-probe.json` via `curl` to `/api/talk`; no UI button; line carries `source:"fixture"` (§13) |
| 17 | UI dev feed (G3) | Frozen | Server cwd `staging/ui-dev/` with copied charter + sample log; `OFFLINE` never changes `/api/log` (§13) |
| 18 | Task board (G4) | Frozen | `BOARD.md` in §7 layout; written only by Yevhenii; agents read only |
| 19 | Live Talk owner (M3.0) | Frozen | Max, first C3 card, 30-min timebox, done by +4.75; Yevhenii calls the +5.0 row (§14) |
| 20 | `fresh.ts` / `mock.ts` owners | Frozen | Max: `fresh.ts` at C2 before take0; `mock.ts` at C1 if live provider fails, else before the jury (§14) |
| 21 | `/api/log` line shape | Frozen | Parsed log objects (§12 shape), never raw strings (§13) |
| 22 | Chip B Reuse path | Frozen | `reuse-company-b.json`: `job.skill: null` → Reuse by capability (§9, §13) |

Public term **"Forge" only**.

---

## 19. Dawn definition of done (10 checkboxes)

All ten by 07:10, or Go/No-Go ships take1.

- [ ] Boot fails with `exit(1)` and a `charter_pin_mismatch` line when one byte of `charter.md` changes (LF-normalised hash, `.gitattributes` committed incl. `skills/** -text`)
- [ ] `hand_probe` Reuse runs in a child process (stdin closed) with timeout and stripped env; Broker grants only `decision.json` env names (hand_probe's = committed seed, disclosed); an ungranted key reads `undefined`
- [ ] One http-template skill is forged (LLM params only, rendered via `JSON.stringify`), passes the Runner-owned test (fixed schema + ≥1 `url`), FINAL hash = PRE hash, Installs
- [ ] After a server restart, a second company Reuses that skill by the deterministic Runner rule, with `query` from stdin: log shows `matched` / `reuse`, no `forge`, folder hash verified
- [ ] Email prompt → tripwire before Talk → `capability_not_allowed` from Warden (job needs, manifest, scan); staging wiped; **exactly one** `denied` line carries `voice`; `denied.wav` plays once
- [ ] Every `surgery.log` line carries the same `charterHash`; strip says "charter unchanged since boot · granted ⊆ charter", derived from `caps`
- [ ] Talk never writes `skills/`; every DENIED on video has `actor: warden`; denied/broken `reply` is templated, not LLM
- [ ] UI renders only from `/api/log` + Talk; voice plays only for new lines; no Reset button, no Voice toggle
- [ ] Take0 recorded by +4.25 and uploaded by +4.5; final video ≤2:00 with burned-in subtitles, upload started by 06:40, done by 07:00
- [ ] `npm run validate` results on a Works / Simulated / Incomplete slide: scan ≠ sandbox; `net:fetch` can reach email APIs; tripwire is a keyword match with a listed known miss; judge-mode / fixtures disclosed if used

---

*Spec version: Nightborn v3.2.5 (re-sync on v3.2.4 — Brave + voice ID frozen, Apify gate wording, ambiguous-match rule, role split matches BOARD.md; v3.2.4: hand_probe seed, take0 probe fixture, UI dev feed, live Talk owner, fresh/mock owners, BOARD.md)*
