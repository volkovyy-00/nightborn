import { readFileSync, existsSync } from "node:fs";
import type { Hono } from "hono";
import { repoPath } from "./paths.ts";

/** `GET /mock/:host/*` → fixture JSON (served by the OFFLINE server and by validate.ts's own mock server). */
export function mountMock(app: Hono): void {
  app.get("/mock/:host/*", (c) => {
    const host = c.req.param("host");
    const url = new URL(c.req.url);
    const body = mockResponse(host, url.pathname.slice(`/mock/${host}`.length), url.searchParams);
    return body === null ? c.json({ error: "no fixture" }, 404) : c.json(body);
  });
}

/**
 * OFFLINE provider mock (SPEC §9 "OFFLINE mode"): `/mock/<host>/<path>?<query>` served from flat
 * `fixtures/http/*.json`. Brave news / web by path + `q`; any other host by `<host>.json`.
 */
function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function firstExisting(names: string[]): unknown | null {
  for (const n of names) {
    const p = repoPath("fixtures", "http", n);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  return null;
}

export function mockResponse(host: string, pathname: string, params: URLSearchParams): unknown | null {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null; // plain hostnames only (no ../ via %2F)
  if (host === "api.search.brave.com") {
    const kind = pathname.includes("/web/") ? "web" : "news";
    const q = params.get("q") ?? "";
    const tokens = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return firstExisting([
      `${kind}-${slug(q)}.json`,
      ...tokens.map((t) => `${kind}-${t}.json`),
      `${kind}-default.json`,
    ]);
  }
  // Any other host: `<host>-<slug(param value)>.json` for each query value (e.g. www.sauto.cz-tesla-model-3.json
  // from manufacturer_model_seo=tesla:model-3; hn.algolia.com-rust.json from query=rust), then `<host>.json`.
  const byValue = [...params.values()].map((v) => slug(v)).filter(Boolean).map((v) => `${host}-${v}.json`);
  return firstExisting([...byValue, `${host}.json`]);
}
