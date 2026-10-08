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

// A link with a placeholder that has no value is no link: return "" so a wrong template fails the Test.
function fillLink(template, item) {
  let missing = false;
  const out = String(template).replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, p) => {
    const v = dot(item, p);
    if (v === undefined || v === null || String(v) === "") missing = true;
    return v === undefined || v === null ? "" : String(v);
  });
  return missing ? "" : out;
}

// Numbers as they are; strings only when they hold a digit ("1 234 Kč" → 1234, "1 234,50" → 1234.5).
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string" || !/\d/.test(v)) return NaN;
  let s = v.replace(/[\s\u00a0]/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/,(\d{1,2})$/, ".$1");
  s = s.replace(/[^\d.]/g, "");
  return s ? Number(s) : NaN;
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

let arr = R.itemsPath === "" || R.itemsPath === null ? data : dot(data, R.itemsPath);
if (!Array.isArray(arr)) fail("itemsPath is not an array");

if (R.maxFilter) {
  const limit = Number(inputs[R.maxFilter.input]);
  if (Number.isFinite(limit)) {
    const values = arr.map((it) => num(dot(it, R.maxFilter.field)));
    if (arr.length && !values.some(Number.isFinite)) fail("maxFilter: no numeric field");
    arr = arr.filter((_, i) => Number.isFinite(values[i]) && values[i] <= limit);
  }
}

let items = arr.map((it) => {
  const o = { title: fillItem(R.map.title, it), url: fillLink(R.map.url, it) };
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
