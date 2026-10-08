// hand_probe — committed hand-written probe (kind:"hand"); used only by validate.ts.

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const input = JSON.parse((await readStdin()) || "{}");
const inputs = input.inputs ?? {};
const query = String(inputs.query ?? "probe");
const baseUrl = input.baseUrl;
const max = Number(input.max ?? 3);
const key = process.env.BRAVE_API_KEY;
if (!key && !baseUrl) {
  console.error("missing BRAVE_API_KEY");
  process.exit(1);
}

const u = new URL("https://api.search.brave.com/res/v1/news/search");
u.searchParams.set("q", query);
u.searchParams.set("count", String(max));
u.searchParams.set("freshness", "pw");
const target = baseUrl ? new URL(u.host + u.pathname + u.search, baseUrl) : u;

const res = await fetch(target, {
  headers: { "X-Subscription-Token": key ?? "", Accept: "application/json" },
  signal: AbortSignal.timeout(6000),
});
if (!res.ok) {
  console.error("brave", res.status);
  process.exit(1);
}
const data = await res.json();
const items = (data.results ?? []).slice(0, max).map((r) => ({
  title: String(r.title ?? ""),
  url: String(r.url ?? ""),
  ...(r.description ? { snippet: String(r.description) } : {}),
  ...(r.page_age ? { date: String(r.page_age) } : {}),
}));
process.stdout.write(JSON.stringify({ items }));
