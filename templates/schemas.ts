import { z } from "zod";

export const httpTestSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().min(1),
        date: z.string().optional(),
      }),
    )
    .min(1),
});

export function validateHttpOutput(raw: string): { ok: true; data: z.infer<typeof httpTestSchema> } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not json" };
  }
  const r = httpTestSchema.safeParse(parsed);
  if (!r.success) return { ok: false, reason: r.error.message };
  if (!r.data.items.some((i) => i.url.trim())) return { ok: false, reason: "no url" };
  return { ok: true, data: r.data };
}
