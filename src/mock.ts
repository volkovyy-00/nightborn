import { readFileSync, existsSync } from "node:fs";
import { repoPath } from "./paths.ts";

/** OFFLINE provider mock — serves fixtures/http/news-<slug>.json in provider shape. */
export function mockProviderResponse(provider: string, query: string): unknown {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const candidates = [
    repoPath("fixtures", "http", `news-${slug}.json`),
    repoPath("fixtures", "http", "news-microsoft.json"),
    repoPath("fixtures", "http", "news-default.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  if (provider === "tavily") {
    return {
      results: [
        {
          title: `Stub news for ${query}`,
          url: "https://example.com/news/1",
          published_date: "2026-10-01",
        },
      ],
    };
  }
  return {
    results: [
      {
        title: `Stub news for ${query}`,
        url: "https://example.com/news/1",
        page_age: "2026-10-01",
      },
    ],
  };
}
