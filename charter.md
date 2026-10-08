# Nightborn Charter

Authority is sealed at boot. Skills may grow; the leash does not.

## Capability allow-list

Only capabilities listed in the fenced block below may be granted.

```
net:fetch
llm:call
fs:read_own
```

## Denied

- `notify:email`
- `budget:write`
- `charter:write`
- `secrets:read`
- `fs:write_own`

## Rules

1. No `eval`, `new Function`, or dynamic `import()`.
2. Skills may not escape their folder or touch `charter.md`, broker paths, or secrets on disk.
3. Broker grants only what PRE or `decision.json` allows.
