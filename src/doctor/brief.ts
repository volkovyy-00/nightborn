/**
 * Capability brief — Markdown body + YAML frontmatter for Doctor inbox I/O.
 *
 * Frontmatter (machine): requestId, goalId, auditRef, title, suggestedCaps,
 * optional defaultsHint / changeOf.
 * Body sections (vision §5 Step C): Intent, Minimal success, Why.
 *
 * Round-trip self-check: `npx tsx src/doctor/brief.ts`
 */

import { pathToFileURL } from "node:url";

/** Capability request for the Doctor inbox (vision §6.2 / §11). */
export type CapabilityBrief = {
  requestId: string;
  goalId: string;
  auditRef: string;
  title: string;
  intent: string;
  minimalSuccess: string;
  suggestedCaps: string[];
  /** Key into defaults/capabilities.yaml (see src/defaults.ts). */
  defaultsHint?: string;
  /** Skill name when this is a patch / change request. */
  changeOf?: string;
  /** Verbatim user message — Forge prompt authoritative input. */
  userAsk?: string;
  why: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Serialize a brief to Markdown with YAML frontmatter.
 * Body uses ## Intent / ## Minimal success / ## Why.
 */
export function serializeBrief(brief: CapabilityBrief): string {
  assertBrief(brief);
  const lines: string[] = [
    "---",
    `requestId: ${yamlScalar(brief.requestId)}`,
    `goalId: ${yamlScalar(brief.goalId)}`,
    `auditRef: ${yamlScalar(brief.auditRef)}`,
    `title: ${yamlScalar(brief.title)}`,
    `suggestedCaps: [${brief.suggestedCaps.map(yamlScalar).join(", ")}]`,
  ];
  if (brief.defaultsHint !== undefined) {
    lines.push(`defaultsHint: ${yamlScalar(brief.defaultsHint)}`);
  }
  if (brief.changeOf !== undefined) {
    lines.push(`changeOf: ${yamlScalar(brief.changeOf)}`);
  }
  if (brief.userAsk !== undefined && brief.userAsk.trim()) {
    lines.push(`userAsk: ${yamlScalar(brief.userAsk.trim())}`);
  }
  lines.push("---", "");
  lines.push("## Intent", brief.intent.trim(), "");
  lines.push("## Minimal success", brief.minimalSuccess.trim(), "");
  lines.push("## Why", brief.why.trim(), "");
  return lines.join("\n");
}

/** Parse a Markdown brief document into a CapabilityBrief. */
export function parseBrief(markdown: string): CapabilityBrief {
  const m = markdown.replace(/^\uFEFF/, "").match(FRONTMATTER_RE);
  if (!m) {
    throw new Error("brief: missing YAML frontmatter (--- ... ---)");
  }
  const fm = parseFrontmatter(m[1]!);
  const body = parseBodySections(m[2]!);

  const suggestedCaps = fm.suggestedCaps;
  if (!Array.isArray(suggestedCaps)) {
    throw new Error("brief: frontmatter suggestedCaps must be an array");
  }

  const brief: CapabilityBrief = {
    requestId: requireString(fm, "requestId"),
    goalId: requireString(fm, "goalId"),
    auditRef: requireString(fm, "auditRef"),
    title: requireString(fm, "title"),
    intent: body.intent,
    minimalSuccess: body.minimalSuccess,
    suggestedCaps: suggestedCaps.map(String),
    why: body.why,
  };
  if (typeof fm.defaultsHint === "string" && fm.defaultsHint.length > 0) {
    brief.defaultsHint = fm.defaultsHint;
  }
  if (typeof fm.changeOf === "string" && fm.changeOf.length > 0) {
    brief.changeOf = fm.changeOf;
  }
  if (typeof fm.userAsk === "string" && fm.userAsk.length > 0) {
    brief.userAsk = fm.userAsk;
  }
  assertBrief(brief);
  return brief;
}

function assertBrief(brief: CapabilityBrief): void {
  for (const key of ["requestId", "goalId", "auditRef", "title", "intent", "minimalSuccess", "why"] as const) {
    if (typeof brief[key] !== "string" || !brief[key].trim()) {
      throw new Error(`brief: ${key} must be a non-empty string`);
    }
  }
  if (!Array.isArray(brief.suggestedCaps)) {
    throw new Error("brief: suggestedCaps must be an array");
  }
}

function requireString(fm: Record<string, unknown>, key: string): string {
  const v = fm[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`brief: frontmatter missing ${key}`);
  }
  return v;
}

function yamlScalar(s: string): string {
  // Quote when YAML-special or ambiguous.
  if (
    s === "" ||
    /[:#{}[\],&*?|>!%@`]/.test(s) ||
    /^\s|\s$/.test(s) ||
    /^(true|false|null|~)$/i.test(s) ||
    /[\r\n]/.test(s)
  ) {
    return JSON.stringify(s);
  }
  return s;
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new Error(`brief: invalid frontmatter line: ${raw}`);
    }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (key === "suggestedCaps") {
      out[key] = parseFlowArray(rest);
      continue;
    }
    if (
      key === "requestId" ||
      key === "goalId" ||
      key === "auditRef" ||
      key === "title" ||
      key === "defaultsHint" ||
      key === "changeOf" ||
      key === "userAsk"
    ) {
      out[key] = unquote(rest);
      continue;
    }
    throw new Error(`brief: unknown frontmatter field "${key}"`);
  }
  return out;
}

function parseFlowArray(s: string): string[] {
  const m = s.match(/^\[(.*)\]$/);
  if (!m) throw new Error(`brief: suggestedCaps expected flow array [...], got: ${s}`);
  const inner = m[1]!.trim();
  if (!inner) return [];
  return inner.split(",").map((part) => unquote(part.trim())).filter(Boolean);
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    try {
      if (s.startsWith('"')) return JSON.parse(s) as string;
    } catch {
      /* fall through */
    }
    return s.slice(1, -1);
  }
  return s;
}

function parseBodySections(body: string): {
  intent: string;
  minimalSuccess: string;
  why: string;
} {
  const sections: Record<string, string> = {};
  const parts = body.split(/^##\s+/m);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const nl = trimmed.indexOf("\n");
    const heading = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim().toLowerCase();
    const content = (nl === -1 ? "" : trimmed.slice(nl + 1)).trim();
    if (heading === "intent") sections.intent = content;
    else if (heading === "minimal success") sections.minimalSuccess = content;
    else if (heading === "why") sections.why = content;
    // Ignore other headings (e.g. Suggested caps leftover) for forward-compat.
  }
  if (!sections.intent) throw new Error('brief: body missing "## Intent" section');
  if (!sections.minimalSuccess) {
    throw new Error('brief: body missing "## Minimal success" section');
  }
  if (!sections.why) throw new Error('brief: body missing "## Why" section');
  return {
    intent: sections.intent,
    minimalSuccess: sections.minimalSuccess,
    why: sections.why,
  };
}

/** Deep equality for round-trip asserts (order of suggestedCaps matters). */
export function briefsEqual(a: CapabilityBrief, b: CapabilityBrief): boolean {
  return (
    a.requestId === b.requestId &&
    a.goalId === b.goalId &&
    a.auditRef === b.auditRef &&
    a.title === b.title &&
    a.intent === b.intent &&
    a.minimalSuccess === b.minimalSuccess &&
    a.why === b.why &&
    a.defaultsHint === b.defaultsHint &&
    a.changeOf === b.changeOf &&
    a.userAsk === b.userAsk &&
    a.suggestedCaps.length === b.suggestedCaps.length &&
    a.suggestedCaps.every((c, i) => c === b.suggestedCaps[i])
  );
}

// --- round-trip self-check (small script; no Forge) ---
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const sample: CapabilityBrief = {
    requestId: "req_scrape_a",
    goalId: "goal_used_car_deals",
    auditRef: "aud_100",
    title: "scrape_site_a",
    intent: "Scrape used-car listing cards from Site A.",
    minimalSuccess:
      'Given `{ "query": "BMW under 10k" }`, return `{ "items": [{ "title", "url" }] }`.',
    suggestedCaps: ["net:fetch"],
    defaultsHint: "listings.http_scrape",
    why: "Exploration listed Site A; need structured cards to rank deals.",
  };
  const md = serializeBrief(sample);
  const back = parseBrief(md);
  if (!briefsEqual(sample, back)) {
    console.error("round-trip mismatch", { sample, back, md });
    process.exit(1);
  }
  // Optional fields omitted must stay undefined after round-trip.
  const minimal: CapabilityBrief = {
    requestId: "req_x",
    goalId: "g1",
    auditRef: "aud_1",
    title: "t",
    intent: "i",
    minimalSuccess: "ok",
    suggestedCaps: [],
    why: "because",
  };
  if (!briefsEqual(minimal, parseBrief(serializeBrief(minimal)))) {
    console.error("minimal round-trip failed");
    process.exit(1);
  }
  const withChange: CapabilityBrief = { ...minimal, changeOf: "old_skill" };
  if (!briefsEqual(withChange, parseBrief(serializeBrief(withChange)))) {
    console.error("changeOf round-trip failed");
    process.exit(1);
  }
  const withAsk: CapabilityBrief = {
    ...minimal,
    userAsk: "Get The facebook marketplace deals for tesla cars under 10k",
  };
  if (!briefsEqual(withAsk, parseBrief(serializeBrief(withAsk)))) {
    console.error("userAsk round-trip failed");
    process.exit(1);
  }
  console.log("brief round-trip ok");
}
