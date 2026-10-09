/**
 * Host-side Composio catalog for Cursor Forge re-prompt.
 * session.search → Composio APIFY_* tool slugs; APIFY_STORE_GET → Actor ids.
 */

import {
  executeComposioTool,
  searchComposioTools,
} from "./composio.ts";

const TOOLS_CLIP = 3000;
const ACTORS_CLIP = 2000;

/** Marketplace / bot-walled asks need Store actor discovery, not just tool search. */
export function needsStoreActorDiscovery(intentOrAsk: string): boolean {
  const t = intentOrAsk.toLowerCase();
  return (
    /marketplace|facebook|linkedin|indeed|bot[- ]?wall|hard scrape|apify|actor/i.test(
      t,
    ) || /fb\b/i.test(t)
  );
}

function clipText(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

export function composioUseCaseQuery(intentOrAsk: string): string {
  const t = intentOrAsk.toLowerCase();
  if (/marketplace|facebook|\bfb\b/i.test(t)) {
    return "run apify actor get dataset items facebook marketplace";
  }
  if (/linkedin|indeed/i.test(t)) {
    return "run apify actor get dataset items scraper";
  }
  return clipText(`run apify actor get dataset items ${intentOrAsk}`, 80);
}

export function storeSearchString(intentOrAsk: string): string {
  const t = intentOrAsk.toLowerCase();
  if (/marketplace|facebook|\bfb\b/i.test(t)) return "facebook marketplace";
  if (/linkedin/i.test(t)) return "linkedin";
  if (/indeed/i.test(t)) return "indeed jobs";
  const cleaned = intentOrAsk
    .replace(/[<>$]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned || "web scraper";
}

function summarizeSearchResult(result: unknown): string {
  try {
    const raw = JSON.stringify(result);
    // Prefer lines that look like APIFY_ tool slugs when present.
    const slugHits = raw.match(/APIFY_[A-Z0-9_]+/g);
    const unique = slugHits ? [...new Set(slugHits)].slice(0, 40) : [];
    const slugBlock =
      unique.length > 0
        ? `Known APIFY_* slugs from search:\n${unique.join("\n")}\n\n`
        : "";
    return clipText(slugBlock + raw, TOOLS_CLIP);
  } catch {
    return clipText(String(result), TOOLS_CLIP);
  }
}

/** Pull username/name or id-like Actor refs from Store list payload. */
export function extractActorIdsFromStoreData(data: unknown): string[] {
  const found = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!t || t.length > 120) return;
    // username/actor or username~actor or bare id
    if (
      /^[a-z0-9_-]+[~\/][a-z0-9_-]+$/i.test(t) ||
      /^[a-zA-Z0-9]{8,}$/.test(t)
    ) {
      found.add(t.replace(/\//g, "~"));
    }
  };

  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || found.size >= 40) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") {
      if (typeof node === "string") add(node);
      return;
    }
    const o = node as Record<string, unknown>;
    const username =
      typeof o.username === "string"
        ? o.username
        : typeof o.userName === "string"
          ? o.userName
          : "";
    const name =
      typeof o.name === "string"
        ? o.name
        : typeof o.actorName === "string"
          ? o.actorName
          : "";
    if (username && name) add(`${username}/${name}`);
    for (const key of ["id", "actorId", "actId", "username", "name", "title"]) {
      if (typeof o[key] === "string") add(o[key] as string);
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };

  walk(data, 0);
  return [...found].slice(0, 30);
}

/** Prefer username~name over bare ids for GET_ACTOR / RUN_ACTOR. */
export function preferNamedActorIds(ids: string[]): string[] {
  const named = ids.filter((id) => id.includes("~"));
  const bare = ids.filter((id) => !id.includes("~"));
  return [...named, ...bare];
}

type JsonSchemaLike = {
  required?: unknown;
  properties?: Record<string, unknown>;
};

/** Walk GET_ACTOR / Store payloads for an input JSON schema. */
export function findInputSchema(data: unknown): JsonSchemaLike | null {
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number): JsonSchemaLike | null => {
    if (depth > 10 || !node || typeof node !== "object") return null;
    if (seen.has(node as object)) return null;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    const o = node as Record<string, unknown>;
    for (const key of [
      "inputSchema",
      "input_schema",
      "defaultRunInputSchema",
      "jsonSchema",
    ]) {
      const v = o[key];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const schema = v as JsonSchemaLike;
        if (schema.properties || Array.isArray(schema.required)) return schema;
      }
    }
    if (o.properties && typeof o.properties === "object") {
      const schema = o as JsonSchemaLike;
      if (Array.isArray(schema.required) || "startUrls" in (schema.properties || {})) {
        return schema;
      }
    }
    for (const v of Object.values(o)) {
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(data, 0);
}

/** Fallback when nested schema walk misses truncated GET_ACTOR payloads. */
export function inferStartUrlsRequired(data: unknown): boolean {
  try {
    const raw = JSON.stringify(data);
    if (!/"startUrls"/.test(raw)) return false;
    if (/"required"\s*:\s*\[[^\]]*"startUrls"/.test(raw)) return true;
    // Common Marketplace scrapers expose startUrls as the primary input.
    return /facebook|marketplace/i.test(raw) && /"startUrls"\s*:\s*\{/.test(raw);
  } catch {
    return false;
  }
}

export function summarizeActorInputHint(
  actorId: string,
  data: unknown,
): string {
  const schema = findInputSchema(data);
  const required = Array.isArray(schema?.required)
    ? schema!.required!.filter((x): x is string => typeof x === "string").slice(0, 12)
    : [];
  const propKeys = schema?.properties
    ? Object.keys(schema.properties).slice(0, 20)
    : [];
  const props = [...new Set([...required, ...propKeys])].slice(0, 16);
  const needsStart =
    required.includes("startUrls") ||
    props.includes("startUrls") ||
    inferStartUrlsRequired(data);
  if (needsStart) {
    return (
      `${actorId}: REQUIRED startUrls=[{url:<marketplace search URL>}]` +
      (props.length
        ? `; other fields: ${props.filter((p) => p !== "startUrls").join(",")}`
        : "")
    );
  }
  if (required.length) {
    return `${actorId}: required=[${required.join(",")}] props=[${props.join(",")}]`;
  }
  if (props.length) {
    return `${actorId}: props=[${props.join(",")}]`;
  }
  return `${actorId}: (no input schema parsed — check APIFY_GET_ACTOR before RUN)`;
}

/**
 * Fetch input hints for the first few named Actors (APIFY_GET_ACTOR).
 * Failures are skipped so catalog build still returns tool + actor lists.
 */
export async function fetchActorInputHints(
  skillName: string,
  actorIds: string[],
  limit = 3,
): Promise<string[]> {
  const named = preferNamedActorIds(actorIds).filter((id) => id.includes("~"));
  const picked = (named.length ? named : preferNamedActorIds(actorIds)).slice(
    0,
    limit,
  );
  const hints: string[] = [];
  for (const actorId of picked) {
    const got = await executeComposioTool(
      "APIFY_GET_ACTOR",
      { actorId },
      skillName,
    );
    if (!got.ok) {
      hints.push(`${actorId}: (APIFY_GET_ACTOR failed: ${got.error})`);
      continue;
    }
    hints.push(summarizeActorInputHint(actorId, got.data));
  }
  return hints;
}

/**
 * Build COMPOSIO_TOOLS (+ optional APIFY_ACTORS) text for Cursor Forge re-prompt.
 */
export async function buildForgeComposioCatalog(
  skillName: string,
  intentOrAsk: string,
): Promise<string> {
  const parts: string[] = [];
  const useCase = composioUseCaseQuery(intentOrAsk);

  const search = await searchComposioTools(skillName, useCase);
  if (!search.ok) {
    parts.push(
      `COMPOSIO_TOOLS:\n(search failed: ${search.error})\nPrefer APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS or APIFY_STORE_GET if known — never invent APIFY_RUN_ACTOR_* names.`,
    );
  } else {
    parts.push(
      `COMPOSIO_TOOLS (use ONLY a tool slug from this list; never invent APIFY_* names not listed):\n${summarizeSearchResult(search.result)}`,
    );
  }

  if (needsStoreActorDiscovery(intentOrAsk)) {
    const storeQ = storeSearchString(intentOrAsk);
    const store = await executeComposioTool(
      "APIFY_STORE_GET",
      { search: storeQ, limit: 15 },
      skillName,
    );
    if (!store.ok) {
      parts.push(
        `APIFY_ACTORS:\n(store search failed: ${store.error})\nDo not invent owner~actor names. Fail closed if you cannot pick a real actorId.`,
      );
    } else {
      const ids = preferNamedActorIds(extractActorIdsFromStoreData(store.data));
      if (ids.length === 0) {
        parts.push(
          `APIFY_ACTORS:\n(no actor ids parsed from APIFY_STORE_GET for search=${JSON.stringify(storeQ)}; raw clip below)\n${clipText(JSON.stringify(store.data), ACTORS_CLIP)}\nDo not invent actorIds.`,
        );
      } else {
        parts.push(
          `APIFY_ACTORS (actorId must be from this list — use username~name form):\n${ids.join("\n")}`,
        );
        const hints = await fetchActorInputHints(skillName, ids, 3);
        if (hints.length) {
          parts.push(
            `ACTOR_INPUT_HINTS (APIFY_RUN_ACTOR input MUST satisfy these; invalid-input = missing required fields):\n${hints.join("\n")}`,
          );
        }
      }
    }
  }

  const marketplace =
    /marketplace|facebook|\bfb\b/i.test(intentOrAsk);
  parts.push(
    [
      "Hard rules for skillSource:",
      "- POST JSON {tool, arguments} to input.composioProxyUrl.",
      "- tool = exact COMPOSIO_TOOLS slug; actorId = exact APIFY_ACTORS entry when running an Actor.",
      "- APIFY_RUN_ACTOR arguments must include every required field from ACTOR_INPUT_HINTS for that actorId.",
      "- Do not fall through to a second actor with a different schema unless that attempt also includes its required fields.",
      marketplace
        ? "- Facebook Marketplace Actors usually require startUrls:[{url:\"https://www.facebook.com/marketplace/...\"}] (not searchQueries alone)."
        : "",
      "- Never put / inside a regex literal in skillSource; use includes() or new RegExp without slash delimiters.",
      "- Map dataset/rows to {items:[{title,url,date?}]}; titles must include a model year (19xx/20xx).",
      "- If Composio returns no vehicle cards, exit non-zero — do not Brave-fallback to category/hub pages.",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return parts.join("\n\n");
}
