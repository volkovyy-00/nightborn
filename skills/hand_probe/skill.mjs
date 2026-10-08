// hand_probe — committed seed skill for Broker/hash proof (take0). template:hand

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
const input = JSON.parse(raw || "{}");
const query = input.query ?? "probe";
const baseUrl = input.baseUrl;
const key = process.env.BRAVE_API_KEY;
if (!key) {
  console.error("missing BRAVE_API_KEY");
  process.exit(1);
}

const SLASH = String.fromCharCode(47);
const origin = baseUrl ?? "https://api.search.brave.com";
const root = origin.endsWith(SLASH) ? origin : `${origin}${SLASH}`;
const u = new URL("res/v1/news/search", root);
u.searchParams.set("q", query);
u.searchParams.set("count", "3");
u.searchParams.set("freshness", "pw");

const res = await fetch(u, {
  headers: {
    "X-Subscription-Token": key,
    Accept: "application/json",
  },
  signal: AbortSignal.timeout(6000),
});
if (!res.ok) {
  console.error("brave", res.status);
  process.exit(1);
}
const data = await res.json();
const items = (data.results ?? []).map((r) => ({
  title: r.title ?? "",
  url: r.url ?? "",
  ...(r.page_age ? { date: r.page_age } : {}),
}));
process.stdout.write(JSON.stringify({ items }));
