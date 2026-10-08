import { readFileSync, existsSync } from "node:fs";
import { repoPath } from "./paths.ts";

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
  return firstExisting([`${host}.json`]);
}
