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
  return null; // opaque body (stream, blob, buffer, params object): not inspected
}

function check(url, headers, body) {
  if (!HOSTS.has(url.hostname)) throw new Error("guard: host not allowed");
  if (!KEY || url.hostname === BRAVE_HOST) return;
  const text = bodyText(body);
  if (text === null) throw new Error("guard: opaque body to a non-Brave host");
  const blob = url.href + "\n" + headerText(headers) + text;
  if (KEY_FORMS.some((k) => blob.includes(k))) throw new Error("guard: key to a non-Brave host");
}

const guarded = async function fetch(input, init) {
  if (!(typeof input === "string" || input instanceof URL || input instanceof Request)) {
    throw new Error("guard: unsupported fetch input");
  }
  // Check exactly what is sent: snapshot init once (spread reads each getter once), build one plain
  // Request from it, check that Request's own url/headers, and pass that same Request on. A URL or
  // Request subclass with lying getters cannot make the checked target differ from the fetched one.
  const opts = init == null ? {} : { ...init };
  const req = new Request(input, { ...opts, redirect: "manual" });
  let body = opts.body;
  if (body === undefined && input instanceof Request && input.body !== null) body = input.body;
  check(new URL(req.url), req.headers, body);
  const res = await realFetch(req);
  if (res.status >= 300 && res.status < 400) throw new Error("guard: redirect blocked");
  return res;
};

Object.defineProperty(globalThis, "fetch", { value: guarded, writable: false, configurable: false });
