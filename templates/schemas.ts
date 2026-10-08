// Runner-owned output schema for skill runs (SPEC §9 "Test and Reuse runs").
import { z } from "zod";
import type { Item } from "../src/types.ts";

export const itemSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string().optional(),
  date: z.string().optional(),
});

export const outputSchema = z.object({ items: z.array(itemSchema) });

/** A Builder-written manifest.json (SPEC §9 "Manifest"); name/kind are normalised by the host after this check. */
export const manifestSchema = z.object({
  name: z.string().min(1).max(60),
  purpose: z.string().min(1).max(300),
  inputs: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z_]{1,24}$/),
        type: z.enum(["string", "number"]),
        format: z.enum(["text", "slug"]),
        required: z.boolean(),
        description: z.string().max(120),
      }),
    )
    .min(1)
    .max(6),
  capabilities: z.array(z.string()),
  hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)),
});

export type ParseResult = { ok: true; items: Item[] } | { ok: false; reason: "not_json" | "shape" };
export type TestResult =
  | { ok: true; items: Item[] }
  | { ok: false; reason: "not_json" | "shape" | "no_items" | "no_url" };

/** Shape check only; 0 items is fine (a Reuse run with no hits is still a reuse). */
export function parseItems(stdout: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const r = outputSchema.safeParse(parsed);
  if (!r.success) return { ok: false, reason: "shape" };
  return { ok: true, items: r.data.items };
}

/** The Test check: shape + ≥1 item + ≥1 item with a non-empty url. */
export function validateOutput(stdout: string): TestResult {
  const r = parseItems(stdout);
  if (!r.ok) return r;
  if (r.items.length === 0) return { ok: false, reason: "no_items" };
  if (!r.items.some((i) => i.url.trim() !== "")) return { ok: false, reason: "no_url" };
  return r;
}
