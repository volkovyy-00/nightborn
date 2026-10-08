# Nightborn Charter

Authority is sealed at boot. Hands may grow; the leash does not.
Code reads only the four fenced blocks below, by their names. Prose is for humans.

## Capabilities a hand may use

```caps-allow
net:fetch
fs:read_own
```

## Capabilities no hand may ever use

Hands are deterministic: they never call a language model.

```caps-deny
llm:call
notify:email
budget:write
charter:write
secrets:read
fs:write_own
```

## Hosts no hand may ever reach

```never-hosts
api.sendgrid.com
api.mailgun.net
api.postmarkapp.com
api.resend.com
api.twilio.com
api.stripe.com
hooks.slack.com
openrouter.ai
```

## Forge limits

Forge sessions have exactly these tools, write only into their staging folder, never read secrets,
never install. The host enforces the limits.

```forge
recipe_tools: web_search http_get emit_recipe
recipe_max_turns: 6
recipe_max_seconds: 60
code_tools: web_search http_get write_skill run_test submit_skill
code_max_turns: 16
code_max_seconds: 150
code_max_test_runs: 3
```
