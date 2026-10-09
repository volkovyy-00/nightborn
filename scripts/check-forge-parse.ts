/**
 * Regression: Cursor agent often prefixes prose before forge JSON in envelope.result.
 * CLI forge must unwrap that into access requests or skillSource artifacts.
 */
import {
  asAccessRequest,
  parseAgentForgePayload,
  parseAgentForgeStdout,
} from "../src/forgeCursorCli.ts";

function envelope(result: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// Reproduced Facebook shape: prose + needs_composio_access
{
  const stdout = envelope(
    `I'll check how Forge skills and Composio access requests are shaped in this repo so the JSON matches the runtime.` +
      `{"needs_composio_access":true,"toolkit":"apify","why":"Facebook Marketplace is bot-walled"}`,
  );
  const payload = parseAgentForgePayload(stdout);
  const access = asAccessRequest(payload);
  assert(access, "prose+access: expected needs_composio_access");
  assert(access.toolkit === "apify", `prose+access: toolkit=${access.toolkit}`);
}

// Reproduced Edmunds shape: prose + full artifact with skillSource
{
  const artJson = JSON.stringify({
    name: "scrape_edmunds",
    purpose: "Scrape used-car listing cards from Edmunds",
    query: "used cars under 100000",
    capabilities: ["net:fetch"],
    skillSource:
      "// Nightborn site-scoped listing search\nconst SITE = \"edmunds.com\";\nprocess.stdout.write(JSON.stringify({ items: [] }));\n",
  });
  const stdout = envelope(
    `I'll check how listing scrape skills are shaped.I'll build the Edmunds listing skill.${artJson}`,
  );
  const art = parseAgentForgeStdout(stdout);
  assert(art.name === "scrape_edmunds", `prose+skill: name=${art.name}`);
  assert(
    Boolean(art.skillSource?.includes("edmunds.com")),
    "prose+skill: skillSource missing site",
  );
}

// Pure JSON result (no prose) still works
{
  const stdout = envelope(
    JSON.stringify({
      name: "t",
      purpose: "p",
      query: "q",
      capabilities: ["net:fetch"],
      skillSource: "console.log(1)",
    }),
  );
  const art = parseAgentForgeStdout(stdout);
  assert(art.skillSource === "console.log(1)", "pure JSON skillSource");
}

console.log("check-forge-parse: ok");
