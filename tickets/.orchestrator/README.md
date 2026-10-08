# Orchestrator bus

Side channel between tmux ticket workers and the human/orchestrator chat.

Workers may always write here (not part of any ticket write-set).

## Worker → orchestrator

Append one JSON object per line to `inbox.jsonl`:

```json
{"ts":"2026-10-08T21:00:00Z","ticket":"T01","level":"block","msg":"Need src/types.ts","needPaths":["src/types.ts"]}
```

| level | When |
|-------|------|
| `block` | Cannot finish without a decision or extra path |
| `ask` | Question; can keep exploring meanwhile |
| `info` | Notable status (optional; prefer ticket checklist) |

Then poll `replies/<TICKET>.md` every ~30s.

## Orchestrator → worker

Write `replies/<TICKET>.md` with the decision. Optionally nudge the pane via `tmux send-keys`.
