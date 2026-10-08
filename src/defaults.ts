/**
 * Defaults capability registry — sane templates for common Doctor hints.
 *
 * Missing hint policy: getDefault(hint) returns null (caller decides whether
 * to invent or fail). loadDefaults() throws if the YAML file is missing/invalid.
 */

import { readFileSync } from "node:fs";
import { repoPath } from "./paths.ts";

export type CapabilityDefault = {
  description: string;
  caps: string[];
  envKeys: string[];
  notes?: string;
  /** Optional alternate env keys (e.g. Tavily when Brave is primary). */
  fallbackEnvKeys?: string[];
};

export type DefaultsRegistry = Record<string, CapabilityDefault>;

const DEFAULTS_FILE = repoPath("defaults", "capabilities.yaml");

let cached: DefaultsRegistry | null = null;

/** Load (and cache) the full defaults registry from defaults/capabilities.yaml. */
export function loadDefaults(opts?: { reload?: boolean }): DefaultsRegistry {
  if (cached && !opts?.reload) return cached;
  const text = readFileSync(DEFAULTS_FILE, "utf8");
  cached = parseCapabilitiesYaml(text);
  return cached;
}

/**
 * Look up one capability default by hint key (e.g. "search.web").
 * Returns null when the hint is absent — does not throw.
 */
export function getDefault(hint: string): CapabilityDefault | null {
  const registry = loadDefaults();
  return Object.prototype.hasOwnProperty.call(registry, hint) ? registry[hint]! : null;
}

/** Clear cache (tests / after editing the YAML on disk). */
export function clearDefaultsCache(): void {
  cached = null;
}

// --- constrained YAML parser for this registry shape only ---

function parseCapabilitiesYaml(text: string): DefaultsRegistry {
  const out: DefaultsRegistry = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  let currentKey: string | null = null;
  let current: Partial<CapabilityDefault> = {};

  const flush = () => {
    if (!currentKey) return;
    const entry = finalizeEntry(currentKey, current);
    out[currentKey] = entry;
    currentKey = null;
    current = {};
  };

  while (i < lines.length) {
    const raw = lines[i]!;
    const line = stripComment(raw);
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // Top-level key: "name.with.dots:"
    const top = line.match(/^([A-Za-z0-9_.-]+):\s*$/);
    if (top && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      currentKey = top[1]!;
      current = {};
      i++;
      continue;
    }

    if (!currentKey) {
      throw new Error(`defaults yaml: unexpected line before any key: ${raw}`);
    }

    // Indented field
    const field = line.match(/^  ([A-Za-z0-9_]+):\s*(.*)$/);
    if (!field) {
      throw new Error(`defaults yaml: expected indented field under ${currentKey}: ${raw}`);
    }
    const name = field[1]!;
    const rest = field[2]!.trim();

    if (name === "notes" && rest === "|") {
      const { value, next } = readBlock(lines, i + 1);
      current.notes = value;
      i = next;
      continue;
    }

    if (name === "description") {
      current.description = unquote(rest);
      i++;
      continue;
    }

    if (name === "caps" || name === "envKeys" || name === "fallbackEnvKeys") {
      current[name] = parseFlowArray(rest);
      i++;
      continue;
    }

    throw new Error(`defaults yaml: unknown field "${name}" under ${currentKey}`);
  }

  flush();
  return out;
}

function finalizeEntry(key: string, partial: Partial<CapabilityDefault>): CapabilityDefault {
  if (typeof partial.description !== "string" || !partial.description) {
    throw new Error(`defaults yaml: ${key} missing description`);
  }
  if (!Array.isArray(partial.caps)) {
    throw new Error(`defaults yaml: ${key} missing caps[]`);
  }
  if (!Array.isArray(partial.envKeys)) {
    throw new Error(`defaults yaml: ${key} missing envKeys[]`);
  }
  const entry: CapabilityDefault = {
    description: partial.description,
    caps: partial.caps,
    envKeys: partial.envKeys,
  };
  if (partial.notes !== undefined) entry.notes = partial.notes;
  if (partial.fallbackEnvKeys !== undefined) entry.fallbackEnvKeys = partial.fallbackEnvKeys;
  return entry;
}

function stripComment(line: string): string {
  // Only strip # comments outside of quoted strings (simple: leading/full-line comments).
  const t = line.trimStart();
  if (t.startsWith("#")) return "";
  return line;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFlowArray(s: string): string[] {
  const m = s.match(/^\[(.*)\]$/);
  if (!m) throw new Error(`defaults yaml: expected flow array [...], got: ${s}`);
  const inner = m[1]!.trim();
  if (!inner) return [];
  return inner.split(",").map((part) => unquote(part.trim())).filter(Boolean);
}

function readBlock(lines: string[], start: number): { value: string; next: number } {
  const chunks: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" && chunks.length === 0) {
      i++;
      continue;
    }
    // Block content is indented more than 2 spaces (field indent).
    if (/^ {4}/.test(line) || /^\t\t/.test(line)) {
      chunks.push(line.replace(/^ {4}/, "").replace(/^\t\t/, ""));
      i++;
      continue;
    }
    // Blank line inside block (preserve as empty line if more content follows)
    if (line.trim() === "") {
      // peek ahead for more indented content
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === "") j++;
      if (j < lines.length && (/^ {4}/.test(lines[j]!) || /^\t\t/.test(lines[j]!))) {
        chunks.push("");
        i++;
        continue;
      }
      break;
    }
    break;
  }
  // YAML literal blocks usually keep a trailing newline; trim trailing blank only.
  while (chunks.length && chunks[chunks.length - 1] === "") chunks.pop();
  return { value: chunks.join("\n"), next: i };
}
