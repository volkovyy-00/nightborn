# Pi branch delta vs SPEC.md

This branch (`pi`) keeps the Nightborn host pipeline (tripwire, Runner, Warden, Broker, templates for DENIED, surgery log, UI merge contract) and swaps the LLM harness.

| SPEC (OpenAI-era wording) | This branch |
|------|-------------|
| Talk = OpenAI structured outputs (`openai` package) | Talk = Pi SDK session (`@earendil-works/pi-coding-agent`), `noTools: "builtin"`, tools `emit_chat` / `emit_job` |
| Forge = free-form `skillSource` (+ metadata) | Forge = one-shot Pi session, tool `emit_forge_skill` |
| Env: `OPENAI_API_KEY` | Env: `OPENROUTER_API_KEY` (or any Pi provider) + `PI_MODEL` |
| Deps: `openai` | Deps: `@earendil-works/pi-coding-agent`, `typebox` |

Frozen elsewhere in SPEC still applies: Warden scan, Broker, tripwire DENIED, Runner Reuse/Create (incl. named-missing grow), merge contract (`POST /api/talk`, `GET /api/log`), free-form Forge for Create (v3.3.0).

See [UI_CONTRACT.md](./UI_CONTRACT.md) for the UI agent handoff.
