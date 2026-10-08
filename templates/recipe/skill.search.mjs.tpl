// Nightborn recipe hand (search: Brave news | web). Rendered by code; the recipe below is JSON.stringify output.
// User values arrive only on stdin. No imports, no fs, one env name.

const R = __RECIPE_JSON__;

const NEWS_URL = "https://api.search.brave.com/res/v1/news/search";
const WEB_URL = "https://api.search.brave.com/res/v1/web/search";
const KEY = process.env.BRAVE_API_KEY;

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function stripMarks(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function slugify(s) {
  return stripMarks(s).trim().replace(/\s+/g, "-");
}

function matchKey(s) {
  return stripMarks(s).replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function fillPattern(pattern, inputs) {
  return pattern.replace(/\{([a-z_]+)\}/g, (_, name) => {
    const spec = R.inputs.find((i) => i.name === name);
    const v = inputs[name];
    if (v === undefined || v === null) return "";
    if (spec && spec.type === "string" && spec.format === "slug") return slugify(v);
    return String(v);
  });
}

let raw = "";
for await (const c of process.stdin) raw += c;
let input;
try {
  input = JSON.parse(raw || "{}");
} catch {
  fail("bad stdin");
}
const inputs = input.inputs ?? {};
const baseUrl = input.baseUrl;
const max = Number.isFinite(Number(input.max)) && Number(input.max) > 0 ? Math.floor(Number(input.max)) : 5;

if (R.endpoint !== "news" && R.endpoint !== "web") fail("unsupported endpoint");
if (!KEY && !baseUrl) fail("missing key");

let q = fillPattern(R.queryPattern ?? "", inputs).trim();
if (R.endpoint === "web" && R.site) q = q + " site:" + R.site;

const u = new URL(R.endpoint === "news" ? NEWS_URL : WEB_URL);
u.searchParams.set("q", q);
u.searchParams.set("count", String(max));
if (R.endpoint === "news") u.searchParams.set("freshness", "pw");
const target = baseUrl ? new URL(u.host + u.pathname + u.search, baseUrl) : u;

const res = await fetch(target, {
  headers: { "X-Subscription-Token": KEY ?? "", Accept: "application/json" },
  signal: AbortSignal.timeout(6000),
});
if (!res.ok) fail("http " + res.status);
const data = await res.json();

const results = R.endpoint === "news" ? data?.results : data?.web?.results;
let items = (Array.isArray(results) ? results : []).map((r) => ({
  title: String(r?.title ?? ""),
  url: String(r?.url ?? ""),
  ...(r?.description ? { snippet: String(r.description) } : {}),
  ...(r?.page_age ? { date: String(r.page_age) } : {}),
}));

if (R.matchInput) {
  const want = matchKey(inputs[R.matchInput] ?? "");
  if (want) items = items.filter((it) => matchKey(it.title).includes(want));
}

process.stdout.write(JSON.stringify({ items: items.slice(0, max) }));
