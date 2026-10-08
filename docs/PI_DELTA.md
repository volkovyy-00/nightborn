# Pi branch delta

This branch (`pi`) keeps the Nightborn host pipeline (tripwire, Runner, Warden, Broker, DENIED template, surgery log, UI merge contract) and uses Pi for Talk/Forge.

| Older OpenAI-era wording | This branch |
|------|-------------|
| Talk = OpenAI structured outputs (`openai` package) | Talk = Pi SDK session (`@earendil-works/pi-coding-agent`), `noTools: "builtin"`, tools `emit_chat` / `emit_job` |
| Forge = free-form `skillSource` (+ metadata) | Forge = one-shot Pi session, tool `emit_forge_skill` |
| Env: `OPENAI_API_KEY` | Env: `OPENROUTER_API_KEY` (or any Pi provider) + `PI_MODEL` |
| Deps: `openai` | Deps: `@earendil-works/pi-coding-agent`, `typebox` |

Host spine still applies in code: Warden scan, Broker, tripwire DENIED, Runner Reuse/Create, `POST /api/talk` + `GET /api/log`, free-form Forge.

See [UI_CONTRACT.md](./UI_CONTRACT.md) for the UI agent handoff.
