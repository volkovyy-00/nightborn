/**
 * Host-side listing merge / rank for multi-scraper goals.
 * Rejects category hub SERP hits so we do not call index pages “best deals.”
 */

import { memoryStore } from "./memory.ts";

export type ListingItem = {
  title: string;
  url: string;
  date?: string;
  source?: string;
  price?: number;
};

export type ListingBatch = {
  skill: string;
  query: string;
  /** Usable (non-hub) vehicle cards. */
  items: ListingItem[];
  /** Counts from stdout before hub filter. */
  rawCount?: number;
  hubCount?: number;
};

export type ListingQuality = {
  ranked: ListingItem[];
  rawCount: number;
  hubCount: number;
  ok: boolean;
  reason?: string;
};

function listingsPath(goalId: string): string {
  return `goals/${goalId}.listings.json`;
}

/** True for search-index / city shopping pages, not a single vehicle card. */
export function isListingHub(title: string, url: string): boolean {
  const t = (title || "").trim();
  const u = (url || "").toLowerCase();
  if (!t && !u) return true;
  if (
    /price-under|used-cars-under|for-sale-under|\/shopping\/|\/seo\/|\/research\/|\/car-reviews|\/appraisal|\/articles\//i.test(
      u,
    )
  ) {
    return true;
  }
  // Edmunds city/model inventory indexes (not a single VIN/VDP card).
  if (/\/used-\d{4}-[a-z0-9-]+/i.test(u)) return true;
  if (/edmunds\.com\/[a-z0-9-]+\/[a-z0-9-]+\/(19|20)\d{2}\/?(\?|$)/i.test(u)) return true;
  if (
    /used cars?\s+for sale|cars?\s+for sale\s+(under|near)|near me\s*\|/i.test(t) ||
    /^used cars?\s+under/i.test(t) ||
    /vehicle\s+pric/i.test(t) ||
    /\bunder\s+\$?\s*[\d,]+\s*(for sale|near)/i.test(t)
  ) {
    return true;
  }
  // Real VDP titles almost always include a model year.
  if (!/\b(19|20)\d{2}\b/.test(t)) return true;
  // Cars.com individual sale cards use /vehicledetail/ or /vehicle/<uuid>/.
  // Model/research/shopping indexes are already rejected above.
  if (/cars\.com/i.test(u) && !/vehicledetail|\/vehicle\/[0-9a-f-]{8}/i.test(u)) {
    return true;
  }
  return false;
}

export type ParsedListingStdout = {
  /** All parsed items before hub filter. */
  raw: ListingItem[];
  /** Non-hub vehicle-like cards. */
  usable: ListingItem[];
  rawCount: number;
  hubCount: number;
};

/** Parse skill stdout; keep raw + usable so quality messaging can report hubs. */
export function parseListingStdout(stdout: string): ParsedListingStdout {
  try {
    const data = JSON.parse(stdout) as { items?: unknown[] };
    if (!Array.isArray(data.items)) {
      return { raw: [], usable: [], rawCount: 0, hubCount: 0 };
    }
    const raw: ListingItem[] = [];
    const usable: ListingItem[] = [];
    let hubCount = 0;
    for (const item of data.items) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const title = typeof o.title === "string" ? o.title.trim() : "";
      const url = typeof o.url === "string" ? o.url.trim() : "";
      if (!title && !url) continue;
      const date = typeof o.date === "string" ? o.date : undefined;
      const price = extractPriceUsd(title);
      const row: ListingItem = {
        title: title || "(untitled)",
        url,
        ...(date ? { date } : {}),
        ...(price != null ? { price } : {}),
      };
      raw.push(row);
      if (isListingHub(title, url)) {
        hubCount++;
        continue;
      }
      usable.push(row);
    }
    return { raw, usable, rawCount: raw.length, hubCount };
  } catch {
    return { raw: [], usable: [], rawCount: 0, hubCount: 0 };
  }
}

/** Non-hub items only (legacy helper). */
export function parseItemsFromStdout(stdout: string): ListingItem[] {
  return parseListingStdout(stdout).usable;
}

/** Asking price in title — ignore “under $10,000” budget copy. */
export function extractPriceUsd(title: string): number | undefined {
  const t = title || "";
  const money: number[] = [];
  for (const m of t.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
    const start = m.index ?? 0;
    const before = t.slice(Math.max(0, start - 12), start).toLowerCase();
    if (/\bunder\s*$/.test(before) || /\bunder\s+$/.test(before)) continue;
    if (/\b(below|less than)\s*$/.test(before)) continue;
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 500 && n <= 250_000) money.push(n);
  }
  if (!money.length) return undefined;
  return Math.min(...money);
}

export function budgetFromQuery(query: string): number | undefined {
  const q = (query || "").toLowerCase();
  const k = q.match(/under\s*\$?\s*([\d.]+)\s*k\b/);
  if (k) {
    const n = Number(k[1]) * 1000;
    return Number.isFinite(n) ? n : undefined;
  }
  const under = q.match(/under\s*\$?\s*([\d,]+)/);
  if (under) {
    const n = Number(String(under[1]).replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  const dollars = q.match(/\$\s*([\d,]+)/);
  if (dollars) {
    const n = Number(String(dollars[1]).replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function mergeAndRank(
  items: ListingItem[],
  budget?: number,
): ListingItem[] {
  const byUrl = new Map<string, ListingItem>();
  for (const it of items) {
    if (isListingHub(it.title, it.url)) continue;
    const key = (it.url || it.title).toLowerCase();
    if (!key) continue;
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, { ...it });
      continue;
    }
    if (it.price != null && prev.price == null) byUrl.set(key, { ...it });
  }
  let merged = [...byUrl.values()];
  if (budget != null) {
    const inBudget = merged.filter((i) => i.price != null && i.price <= budget);
    const unknown = merged.filter((i) => i.price == null);
    // Prefer priced-in-budget; keep a few unknown only if we have almost nothing
    merged = inBudget.length ? inBudget : unknown;
  }
  merged.sort((a, b) => {
    if (a.price != null && b.price != null) return a.price - b.price;
    if (a.price != null) return -1;
    if (b.price != null) return 1;
    return a.title.localeCompare(b.title);
  });
  return merged.slice(0, 8);
}

export function assessListings(
  items: ListingItem[],
  query: string,
): ListingQuality {
  const budget = budgetFromQuery(query);
  let hubCount = 0;
  const usable: ListingItem[] = [];
  for (const it of items) {
    if (isListingHub(it.title, it.url)) {
      hubCount++;
      continue;
    }
    usable.push({
      ...it,
      price: it.price ?? extractPriceUsd(it.title),
    });
  }
  const ranked = mergeAndRank(usable, budget);
  const priced = ranked.filter((i) => i.price != null);
  if (!ranked.length) {
    return {
      ranked: [],
      rawCount: items.length,
      hubCount,
      ok: false,
      reason:
        hubCount > 0
          ? "scrapers returned category/index pages (not individual vehicle listings)"
          : "no listing cards matched the query",
    };
  }
  if (priced.length === 0 && budget != null) {
    return {
      ranked: [],
      rawCount: items.length,
      hubCount,
      ok: false,
      reason:
        "found titles with years but no asking prices — cannot rank deals under budget",
    };
  }
  return { ranked, rawCount: items.length, hubCount, ok: true };
}

export function formatDealsReply(query: string, quality: ListingQuality): string {
  const budget = budgetFromQuery(query);
  const budgetBit =
    budget != null ? ` under $${budget.toLocaleString("en-US")}` : "";
  if (!quality.ok || !quality.ranked.length) {
    return [
      `I cannot honestly give “best deals” for “${query}”${budgetBit}.`,
      quality.reason
        ? `Quality check failed: ${quality.reason}.`
        : "Quality check failed.",
      `Saw ${quality.rawCount} raw hits (${quality.hubCount} look like shopping-index hubs).`,
      "Need vehicle detail pages (year/make/model + asking price), not “Cars for Sale Under $10k” category URLs.",
      "Next: reforge scrapers to target VDP paths (e.g. cars.com/vehicledetail, edmunds inventory) or add a real listing API hand.",
    ].join(" ");
  }
  const lines = quality.ranked.map((it, i) => {
    const price =
      it.price != null ? ` — $${it.price.toLocaleString("en-US")}` : "";
    const src = it.source ? ` · ${it.source}` : "";
    const url = it.url ? `\n   ${it.url}` : "";
    return `${i + 1}. ${it.title}${price}${src}${url}`;
  });
  return (
    `Best deals for “${query}”${budgetBit} (${quality.ranked.length} vehicle listings):\n\n` +
    lines.join("\n")
  );
}

export async function loadListingBatches(goalId: string): Promise<ListingBatch[]> {
  const raw = await memoryStore.read(listingsPath(goalId));
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as { batches?: ListingBatch[] };
    return Array.isArray(data.batches) ? data.batches : [];
  } catch {
    return [];
  }
}

export async function appendListingBatch(
  goalId: string,
  skill: string,
  query: string,
  items: ListingItem[],
  counts?: { rawCount: number; hubCount: number },
): Promise<void> {
  const filtered = items.filter((it) => !isListingHub(it.title, it.url));
  const rawCount = counts?.rawCount ?? items.length;
  const hubCount =
    counts?.hubCount ?? items.filter((it) => isListingHub(it.title, it.url)).length;
  // Always persist a batch row so synthesis can report hubs even when usable=0.
  const batches = await loadListingBatches(goalId);
  batches.push({
    skill,
    query,
    items: filtered.map((it) => ({ ...it, source: it.source || skill })),
    rawCount,
    hubCount,
  });
  await memoryStore.write(
    listingsPath(goalId),
    `${JSON.stringify({ batches }, null, 2)}\n`,
  );
}

export async function synthesizeDealsReply(
  goalId: string,
  query: string,
): Promise<string> {
  const batches = await loadListingBatches(goalId);
  const flat: ListingItem[] = [];
  let rawCount = 0;
  let hubCount = 0;
  for (const b of batches) {
    rawCount += b.rawCount ?? b.items.length;
    hubCount += b.hubCount ?? 0;
    for (const it of b.items) {
      flat.push({
        ...it,
        source: it.source || b.skill,
        price: it.price ?? extractPriceUsd(it.title),
      });
    }
  }
  const quality = assessListings(flat, query);
  quality.rawCount = rawCount || quality.rawCount;
  quality.hubCount = hubCount || quality.hubCount;
  return formatDealsReply(query, quality);
}
