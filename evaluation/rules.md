# Evaluation rules (deferred engine)

Human-readable heuristics for a later Jev-class judge. Outcomes are **approve**, **deny**, or **raise**. No engine reads this file yet; audit records may cite sections via `evalHint.rulesRef` (e.g. `evaluation/rules.md#outbound-calls`).

---

## outbound-calls

Capability requests and skill runs that place phone calls (`notify:phone`, Bland / similar).

### Approve

- Goal memory or user text already asks to contact, verify, or follow up by phone (or equivalent).
- Listings or prior skill results already expose phone numbers; the call is to verify deal details (price, availability, condition).
- Suggested caps are limited to `notify:phone` and `net:fetch` (or other charter-allowed call plumbing); defaults hint matches a known voice capability (e.g. `voice.outbound_bland`).
- Conversational pattern stays one question at a time; no mass dial of unrelated numbers.

### Deny

- Capability request asks for `secrets:read`, `notify:email`, or other caps outside the call path / charter allow-list.
- Call targets are not tied to goal memory or in-session results (cold outreach unrelated to the stated goal).
- Request would install a lying / stub call skill when required secrets (e.g. `BLAND_API_KEY`) are missing — fail closed; wait for `needs_secret` instead.
- Attempt to bypass Broker/Warden or widen charter solely to enable calling.

### Raise

- Calling without a user-visible goal that mentions contact, verify, or phone follow-up.
- Large fan-out (many numbers) with weak ranking or no prior scrape/memory justification.
- Ambiguous whether numbers came from goal-relevant listings vs. unrelated sources.
- Caps or defaults hint drift from known voice templates without a clear why in the brief/audit.

---

## scrape-requests

Capability requests for HTTP scrapers / listing fetchers (`net:fetch`, `listings.http_scrape` and similar).

### Approve

- Scrape targets (hosts/URLs) were discovered in-session (exploration results or goal memory) and match the goal.
- Brief is minimal: stdin `{query}` → `items[{title,url,date?,phone?}]` (or equivalent); caps ⊆ charter, typically `net:fetch`.
- Defaults hint points at a known scrape/search template; no secrets invented beyond registered env keys.
- Scope is listing cards / public pages needed to continue ranking or comparison — not a general web crawl.

### Deny

- Suggested caps include email/SMS send, secrets exfiltration, or anything charter would reject for a scrape skill.
- Target is clearly unrelated to goal memory (wrong domain, personal data harvest, credentialed admin surfaces).
- Brief demands headless browser / automation farm when charter and defaults do not allow it.
- Request tries to skip Warden/Forge and drop code straight into `skills/`.

### Raise

- Scrape target is only weakly related to goal memory (vague “research the web” without named sites).
- Broad host wildcards or unbounded pagination with no minimal-success bound.
- Mixing scrape intent with outbound side effects (email, SMS, calls) in one brief.
- Why/audit trail missing or too thin to judge necessity later.
