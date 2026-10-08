# Audit log

Append-only, goal-centric records for a later evaluator (Jev). Parallel to `surgery.log` (pipeline); do not mix the two.

## Layout — one file per UTC day

```text
audit/
  YYYY-MM-DD.jsonl   # one AuditRecord JSON object per line
  README.md
  .gitkeep
```

Day is taken from the record `ts` (ISO-8601, UTC date prefix). Choose day files (not per-goal) so appends stay cheap and `list({ goalId })` can still filter across days.

## Record shape

Every line has at least `id`, `ts`, `type`, `summary`. Optional: `why`, `goalId`, `data`, `evalHint`.

```ts
type AuditRecord = {
  id: string;
  ts: string;
  type: string; // e.g. goal.started | capability.requested | doctor.* | skill.ran
  summary: string;
  why?: string;
  goalId?: string;
  data?: Record<string, unknown>;
  evalHint?: {
    decision?: "approve" | "deny" | "raise" | "pending";
    rulesRef?: string; // e.g. evaluation/rules.md#outbound-calls
  };
};
```

API: `src/audit.ts` exports `append` and `list({ goalId?, since? })`.

## Secrets

`append` never writes raw secret values. It redacts:

- values of env vars whose names look like keys/tokens/secrets/passwords
- object keys in `data` that look sensitive (`apiKey`, `token`, `authorization`, …)

Env *names* (e.g. `BLAND_API_KEY` in a `needs_secret` payload) are fine to log.

## Smoke (unit-free)

From repo root:

```bash
npx tsx -e '
import { append, list } from "./src/audit.ts";
(async () => {
  const r = await append({
    type: "goal.started",
    summary: "smoke goal",
    goalId: "goal_smoke",
    why: "T01 smoke",
  });
  const rows = await list({ goalId: "goal_smoke" });
  console.log(r.id, rows.length, rows.at(-1)?.summary);
})();
'
```

Expect a new line under `audit/<today-UTC>.jsonl` and a printed id + count ≥ 1.
