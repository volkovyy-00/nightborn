// Fetch guard, preloaded into every skill child with `--import` (SPEC §9 "Execution (sandbox)").
// P1 minimal guard: host set from NB_HOSTS, Brave key only to Brave, redirect:"manual" + throw on 3xx.
// A guard throw makes the skill exit non-zero → Broken test_exit_nonzero.
//
// P2: delete globalThis.WebSocket; stub process.getBuiltinModule (network/process/module builtins throw);
// create undici's lazy global dispatcher eagerly (`await fetch("data:,x")`) and redefine
// globalThis[Symbol.for("undici.globalDispatcher.1")] as writable:false with an origin-checking Proxy
// (constructor hidden, null prototype).

const HOSTS = Object.freeze(new Set((process.env.NB_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean)));
const BRAVE_HOST = "api.search.brave.com";
const KEY = process.env.BRAVE_API_KEY || "";
const KEY_FORMS = KEY ? [KEY, encodeURIComponent(KEY)] : [];
const realFetch = globalThis.fetch;

function headerText(headers) {
  if (!headers) return "";
  let text = "";
  for (const [k, v] of new Headers(headers)) text += `${k}:${v}\n`;
  return text;
}

function bodyText(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return null; // opaque body (stream, blob, buffer): cannot be inspected
}

function check(url, headers, body) {
  if (!HOSTS.has(url.hostname)) throw new Error("guard: host not allowed");
  if (!KEY || url.hostname === BRAVE_HOST) return;
  const text = bodyText(body);
  if (text === null) throw new Error("guard: opaque body to a non-Brave host");
  const blob = url.href + "\n" + headerText(headers) + text;
  if (KEY_FORMS.some((k) => blob.includes(k))) throw new Error("guard: key to a non-Brave host");
}

const guarded = async function fetch(input, init = {}) {
  let url;
  let headers = init?.headers;
  let body = init?.body;
  if (typeof input === "string") url = new URL(input);
  else if (input instanceof URL) url = input;
  else if (input instanceof Request) {
    url = new URL(input.url);
    const merged = new Headers(input.headers);
    for (const [k, v] of new Headers(init?.headers ?? {})) merged.set(k, v);
    headers = merged;
    if (body === undefined && input.body !== null) body = input.body;
  } else throw new Error("guard: unsupported fetch input");
  check(url, headers, body);
  const res = await realFetch(input, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new Error("guard: redirect blocked");
  return res;
};

Object.defineProperty(globalThis, "fetch", { value: guarded, writable: false, configurable: false });
