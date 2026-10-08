# Parallel tickets — agent runtime

Source of truth for *what*: [docs/AGENT_RUNTIME_VISION.md](../docs/AGENT_RUNTIME_VISION.md)  
Branch: `feature/agent-runtime` (do **not** land this on `pi` unless asked).

## How to launch agents

1. Pick a ticket whose `depends` are all `done` (or unblocked).
2. Honor the ticket **`files:` write-set** — write nothing outside it; if you need more paths, stop and ask.
3. One agent per ticket. No two NOW tickets may share a write path.
4. When done: mark status `done` in the ticket frontmatter; leave a short “Done when” checklist checked.
5. Integration tickets (`T09`, `T14`) are **serial** — only one at a time.

## Parallelism map

```text
Wave 0 (launch together)          Wave 1 (after Wave 0)         Wave 2 (serial / careful)
─────────────────────────         ──────────────────────         ────────────────────────
T01 audit                         T06 doctor brief IO            T09 agent loop wire-up
T02 defaults                      T07 doctor async worker          (touches runner/talk/server)
T03 events                        T08 agent wait/resume stubs    T10 needs_secret + env reload
T04 memory                        T11 scheduler (after T03+T04)  T12 audit UI (optional)
T05 eval rules stub               T13 soul + AGENTS              T14 E2E smoke (last)
```

**Truly parallel (no shared files):** T01 ∥ T02 ∥ T03 ∥ T04 ∥ T05  
**Parallel after Wave 0:** T06 ∥ T08 ∥ T11 ∥ T13 (T07 needs T06+T02+T03+T01)  
**Serial:** T09 → T10 → T14 (T12 can float after T01)

## Locked MVP decisions (do not re-litigate)

- Doctor: **in-process**, **async**, Forge **non-blocking**
- Briefs: **Markdown-first** + YAML frontmatter
- Skills: **sequential** `run_skill`
- Secrets: **`.env` + reload** (no UI required)

## Ticket index

| ID | Title | Wave | Depends |
|----|-------|------|---------|
| [T01](T01-audit-sink.md) | Audit schema + file sink | 0 | — |
| [T02](T02-defaults-registry.md) | Defaults capability registry | 0 | — |
| [T03](T03-event-bus.md) | In-process event bus | 0 | — |
| [T04](T04-memory-store.md) | Markdown memory store | 0 | — |
| [T05](T05-eval-rules-stub.md) | Evaluation rules stub | 0 | — |
| [T06](T06-doctor-brief-io.md) | Doctor inbox Markdown I/O | 1 | T02 |
| [T07](T07-doctor-async-worker.md) | Doctor async Forge worker | 1 | T01,T02,T03,T06 |
| [T08](T08-agent-wait-resume.md) | Agent wait / resume stubs | 1 | T03,T04 |
| [T09](T09-agent-loop-wireup.md) | Wire agent loop into host | 2 | T07,T08 |
| [T10](T10-needs-secret.md) | needs_secret + env reload | 2 | T07 |
| [T11](T11-scheduler.md) | Once + cron scheduler | 1 | T03,T04 |
| [T12](T12-audit-ui.md) | Optional audit UI | 2 | T01 |
| [T13](T13-soul-agents.md) | soul.md + AGENTS updates | 1 | — |
| [T14](T14-e2e-smoke.md) | Used-car path smoke | 2 | T09,T10 |
