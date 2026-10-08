# Pi branch delta vs SPEC.md

This branch (`pi`) keeps the Nightborn host pipeline (tripwire, Runner, Warden, Broker, templates, surgery log, UI merge contract) and swaps the LLM harness.

| SPEC | This branch |
|------|-------------|
| Talk = OpenAI structured outputs (`openai` package) | Talk = Pi SDK session (`@earendil-works/pi-coding-agent`), `noTools: "builtin"`, tools `emit_chat` / `emit_job` |
| Forge params = OpenAI structured outputs | Forge = one-shot Pi session, tool `emit_forge_params` |
| Env: `OPENAI_API_KEY` | Env: `OPENROUTER_API_KEY` (or any Pi provider) + `PI_MODEL` |
| Deps: `openai` | Deps: `@earendil-works/pi-coding-agent`, `typebox` |

Frozen elsewhere in SPEC still applies: params-only Forge, deterministic Runner/Warden, tripwire before Talk, merge contract (`POST /api/talk`, `GET /api/log`).

See [UI_CONTRACT.md](./UI_CONTRACT.md) for the UI agent handoff.
