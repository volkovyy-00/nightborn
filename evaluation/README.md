# Evaluation

**Status: deferred.** There is no judge engine in this milestone. Nightborn does not approve/deny/raise capability requests or skill runs at runtime based on these files.

## What lives here

| Path | Role |
|------|------|
| `rules.md` | Human-readable heuristics (`approve` / `deny` / `raise`) for a later Jev-class evaluator. |

## How audit will plug in

When audit is wired, records may carry:

```ts
evalHint?: {
  decision?: "approve" | "deny" | "raise" | "pending";
  rulesRef?: string; // e.g. evaluation/rules.md#outbound-calls
};
```

`evalHint.rulesRef` will point at sections in `evaluation/rules.md`. Until an evaluator lands, leave `decision` unset or `pending`; Doctor and install stay code-leashed (Warden/charter/Broker), not blocked on eval.

## Non-goals (now)

- No runtime module that loads or enforces these rules.
- No UI judge loop.
- Do not install packages (e.g. nodemailer) to silence expected DENIED demos — those paths are product outcomes, not eval failures.
