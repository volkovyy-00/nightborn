/**
 * Extract a JSON value from model/SDK text (raw, fenced, or envelope.result).
 */

export function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("planner_parse: empty text");

  try {
    return JSON.parse(trimmed);
  } catch {
    /* try fence / embedded object */
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    return JSON.parse(fence[1]!.trim());
  }

  const start = trimmed.search(/[\[{]/);
  if (start < 0) throw new Error("planner_parse: no JSON object/array");
  const slice = trimmed.slice(start);
  // Walk braces/brackets for first complete value
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  const open = slice[0];
  const close = open === "[" ? "]" : "}";
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("planner_parse: incomplete JSON");
  return JSON.parse(slice.slice(0, end + 1));
}

/** Prefer envelope.result string/object when present (Cursor / agent CLI style). */
export function unwrapResultEnvelope(root: unknown): unknown {
  if (!root || typeof root !== "object") return root;
  const env = root as Record<string, unknown>;
  if (typeof env.result === "string") {
    try {
      return extractJsonValue(env.result);
    } catch {
      return root;
    }
  }
  if (env.result && typeof env.result === "object") return env.result;
  return root;
}
