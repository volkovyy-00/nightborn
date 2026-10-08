// Nightborn http skill — params rendered via JSON.stringify only for name/purpose in sibling files.
// query always arrives on stdin.

const PROVIDER = "brave";
const ENV_KEY = "BRAVE_API_KEY";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function mapBrave(data) {
  const results = data.results ?? [];
  return {
    items: results.map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      ...(r.page_age ? { date: r.page_age } : {}),
    })),
  };
}

function mapTavily(data) {
  const results = data.results ?? [];
  return {
    items: results.map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      ...(r.published_date ? { date: r.published_date } : {}),
    })),
  };
}

const SLASH = String.fromCharCode(47);

function joinBase(baseUrl, fallbackOrigin, relPath) {
  const base = baseUrl ?? fallbackOrigin;
  const root = base.endsWith(SLASH) ? base : `${base}${SLASH}`;
  const rel = relPath.startsWith(SLASH) ? relPath.slice(1) : relPath;
  return new URL(rel, root);
}

async function searchBrave(query, baseUrl, key) {
  const u = joinBase(baseUrl, "https://api.search.brave.com", "res/v1/news/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", "5");
  u.searchParams.set("freshness", "pw");
  const res = await fetch(u, {
    headers: {
      "X-Subscription-Token": key,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`brave ${res.status}`);
  return mapBrave(await res.json());
}

async function searchTavily(query, baseUrl, key) {
  const url = joinBase(baseUrl, "https://api.tavily.com", "search").href;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `${query} news`,
      topic: "news",
      time_range: "week",
      max_results: 5,
      include_published_date: true,
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  return mapTavily(await res.json());
}

const raw = await readStdin();
const input = JSON.parse(raw || "{}");
const query = input.query ?? "";
const baseUrl = input.baseUrl;
const key = process.env[ENV_KEY];
if (!key) {
  console.error(`missing ${ENV_KEY}`);
  process.exit(1);
}

const out =
  PROVIDER === "tavily"
    ? await searchTavily(query, baseUrl, key)
    : await searchBrave(query, baseUrl, key);

process.stdout.write(JSON.stringify(out));