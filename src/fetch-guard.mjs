// Fetch guard, preloaded into every skill child with `--import` (SPEC §9 "Execution (sandbox)").
// Host set from NB_HOSTS; Brave key only to Brave; redirect:"manual" + throw on 3xx; WebSocket removed;
// process.getBuiltinModule stubbed for network/process/module builtins; undici's global dispatcher created
// eagerly and replaced by a frozen origin-checking Proxy. A guard throw makes the skill exit non-zero →
// Broken test_exit_nonzero. Never relax these to make a run pass.

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
  delete opts.dispatcher; // a caller-supplied dispatcher would bypass the frozen global one
  const req = new Request(input, { ...opts, redirect: "manual" });
  let body = opts.body;
  if (body === undefined && input instanceof Request && input.body !== null) body = input.body;
  check(new URL(req.url), req.headers, body);
  const res = await realFetch(req);
  if (res.status >= 300 && res.status < 400) throw new Error("guard: redirect blocked");
  return res;
};

// ── Other network / escape surfaces ────────────────────────────────────────

delete globalThis.WebSocket;
delete globalThis.EventSource;

const BLOCKED_BUILTINS = /^(node:)?(http|https|http2|net|tls|dgram|dns|dns\/promises|module|worker_threads|child_process|vm)$/;
const realGetBuiltinModule = typeof process.getBuiltinModule === "function" ? process.getBuiltinModule.bind(process) : null;
Object.defineProperty(process, "getBuiltinModule", {
  value: function getBuiltinModule(id) {
    if (BLOCKED_BUILTINS.test(String(id)) || !realGetBuiltinModule) throw new Error("guard: builtin not allowed");
    return realGetBuiltinModule(id);
  },
  writable: false,
  configurable: false,
});

// undici creates its global dispatcher lazily; create it now (through the real fetch, data: URL, no network),
// then freeze an origin-checking Proxy in its place (SPEC §9).
const DISPATCHER_SYM = Symbol.for("undici.globalDispatcher.1");
await realFetch("data:,x").catch(() => {});
const realDispatcher = globalThis[DISPATCHER_SYM];
if (realDispatcher) {
  const originOk = (opts) => {
    if (!opts || opts.origin === undefined) return;
    let host;
    try {
      host = new URL(String(opts.origin)).hostname;
    } catch {
      throw new Error("guard: dispatcher origin");
    }
    if (!HOSTS.has(host)) throw new Error("guard: dispatcher host not allowed");
  };
  const proxy = new Proxy(realDispatcher, {
    get(target, key) {
      if (key === "constructor") return undefined;
      const v = Reflect.get(target, key, target);
      if (typeof v !== "function") return v;
      return function guardedMethod(opts, ...rest) {
        originOk(opts);
        return v.call(target, opts, ...rest);
      };
    },
    getPrototypeOf() {
      return null;
    },
    set() {
      throw new Error("guard: dispatcher is frozen");
    },
    defineProperty() {
      throw new Error("guard: dispatcher is frozen");
    },
  });
  Object.defineProperty(globalThis, DISPATCHER_SYM, { value: proxy, writable: false, configurable: false });
}

Object.defineProperty(globalThis, "fetch", { value: guarded, writable: false, configurable: false });
