// Nightborn recipe hand (json: one HTTP GET of a public JSON API + dot-path map). Rendered by code; the recipe
// below is JSON.stringify output. User values arrive only on stdin. No imports, no fs, no env, no key.

const R = __RECIPE_JSON__;

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

function dot(obj, p) {
  let v = obj;
  for (const k of p.split(".")) {
    if (v === null || v === undefined) return undefined;
    v = v[k];
  }
  return v;
}

function fillUrl(pattern, inputs) {
  return pattern.replace(/\{([a-z_]+)\}/g, (_, name) => {
    const spec = R.inputs.find((i) => i.name === name);
    const v = inputs[name];
    if (v === undefined || v === null) return "";
    const s = spec && spec.type === "string" && spec.format === "slug" ? slugify(v) : String(v);
    return encodeURIComponent(s);
  });
}

function fillItem(template, item) {
  return String(template).replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, p) => {
    const v = dot(item, p);
    return v === undefined || v === null ? "" : String(v);
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

if (R.endpoint !== "json" || !R.urlPattern || !R.map) fail("unsupported recipe");

const u = new URL(fillUrl(R.urlPattern, inputs));
const target = baseUrl ? new URL(u.host + u.pathname + u.search, baseUrl) : u;

const res = await fetch(target, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
if (!res.ok) fail("http " + res.status);
const data = await res.json();

const arr = R.itemsPath === "" || R.itemsPath === null ? data : dot(data, R.itemsPath);
if (!Array.isArray(arr)) fail("itemsPath is not an array");

let items = arr.map((it) => {
  const o = { title: fillItem(R.map.title, it), url: fillItem(R.map.url, it) };
  if (R.map.snippet) {
    const s = fillItem(R.map.snippet, it);
    if (s.trim()) o.snippet = s;
  }
  if (R.map.date) {
    const d = fillItem(R.map.date, it);
    if (d.trim()) o.date = d;
  }
  return o;
});

if (R.matchInput) {
  const want = matchKey(inputs[R.matchInput] ?? "");
  if (want) items = items.filter((it) => matchKey(it.title).includes(want));
}

process.stdout.write(JSON.stringify({ items: items.slice(0, max) }));
