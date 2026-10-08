import { readFileSync, existsSync } from "node:fs";
import { repoPath } from "./paths.ts";

/** OFFLINE provider mock — search fixtures or Bland-shaped call response. */
export function mockProviderResponse(provider: string, query: string): unknown {
  if (provider === "bland") {
    return {
      status: "success",
      call_id: "offline-bland-call-id",
      detail: query.trim() || "outbound",
    };
  }

  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  // Prefer exact slug, then a known company token inside the query, then default — never a wrong company.
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const candidates = [
    repoPath("fixtures", "http", `news-${slug}.json`),
    ...tokens.map((t) => repoPath("fixtures", "http", `news-${t}.json`)),
    repoPath("fixtures", "http", "news-default.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  const label = query.trim() || "query";
  if (provider === "tavily") {
    return {
      results: [
        {
          title: `Stub result for ${label}`,
          url: "https://example.com/stub/1",
          published_date: "2026-10-01T00:00:00Z",
        },
      ],
    };
  }
  return {
    results: [
      {
        title: `Stub result for ${label}`,
        url: "https://example.com/stub/1",
        page_age: "2026-10-01T00:00:00Z",
      },
    ],
  };
}
