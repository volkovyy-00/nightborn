/**
 * Host-side smoke test for Cursor Forge artifacts before Doctor hand-off.
 * Runs skill.mjs once (same contract as Doctor); caller may re-prompt on failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bindingKey,
  composioProxyUrlForSkill,
  setPendingComposioBinding,
  skillComposioUserId,
} from "./composio.ts";
import { grantKeysForCaps, provisionalOr } from "./broker.ts";
import { runSkill } from "./exec.ts";
import { getCharterHash } from "./charter.ts";
import { isListingHub } from "./listings.ts";
import { appendLog } from "./log.ts";
import { validateHttpOutput } from "../templates/schemas.ts";
import type { ForgeArtifact } from "./types.ts";

export type ForgeSmokeResult =
  | { ok: true; detail: string }
  | { ok: false; detail: string };

function clip(s: string, n = 800): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

/** `node --check` so JSON-escaped regex / bad syntax fails before Composio spend. */
export function checkSkillSourceSyntax(src: string): ForgeSmokeResult {
  const dir = mkdtempSync(path.join(tmpdir(), "nightborn-forge-syntax-"));
  const skillPath = path.join(dir, "skill.mjs");
  try {
    writeFileSync(skillPath, src, "utf8");
    const r = spawnSync(process.execPath, ["--check", skillPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (r.status === 0) return { ok: true, detail: "syntax ok" };
    const err = clip((r.stderr || r.stdout || `exit ${r.status}`).trim(), 900);
    return { ok: false, detail: `smoke fail · exit=1 · stderr: ${err}` };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Execute artifact.skillSource once under a temp dir.
 * Sets pending Composio binding when artifact.composio is present.
 */
export async function smokeTestForgeArtifact(opts: {
  artifact: ForgeArtifact;
  /** Display or slug — normalized for proxy + binding. */
  skillName: string;
  testQuery: string;
  defaultsHint?: string;
  timeoutMs?: number;
}): Promise<ForgeSmokeResult> {
  const caps = opts.artifact.capabilities?.length
    ? opts.artifact.capabilities
    : ["net:fetch"];
  if (caps.includes("notify:phone")) {
    return { ok: true, detail: "smoke skipped · notify:phone" };
  }

  const src = opts.artifact.skillSource?.trim() ?? "";
  if (!src) return { ok: false, detail: "empty skillSource" };

  const syntax = checkSkillSourceSyntax(src);
  if (!syntax.ok) return syntax;

  const skillSlug = bindingKey(opts.skillName);
  if (opts.artifact.composio) {
    setPendingComposioBinding(skillSlug, {
      toolkit: opts.artifact.composio.toolkit,
      userId: skillComposioUserId(skillSlug),
    });
  }

  const dir = mkdtempSync(path.join(tmpdir(), "nightborn-forge-smoke-"));
  const skillPath = path.join(dir, "skill.mjs");
  try {
    writeFileSync(skillPath, src, "utf8");
    const input: {
      query: string;
      baseUrl?: string;
      composioProxyUrl?: string;
    } = { query: opts.testQuery };
    if (process.env.OFFLINE === "1") {
      input.baseUrl = `http://127.0.0.1:${process.env.PORT ?? "8787"}/mock`;
    }
    if (opts.artifact.composio) {
      input.composioProxyUrl = composioProxyUrlForSkill(skillSlug);
    }

    let charterHash = "unpinned";
    try {
      charterHash = getCharterHash();
    } catch {
      /* host not booted */
    }
    appendLog({
      actor: "forge",
      event: "forge",
      skill: skillSlug,
      decision: "allow",
      charterHash,
      detail: `smoke · running · query=${clip(opts.testQuery, 80)}`,
    });

    // Composio Apify path: RUN_ACTOR + poll + dataset can exceed 45s.
    const timeoutMs = opts.timeoutMs ?? (opts.artifact.composio ? 120_000 : 15_000);
    const result = await runSkill(
      skillPath,
      dir,
      input,
      provisionalOr(grantKeysForCaps(caps)),
      timeoutMs,
    );

    if (result.timedOut || !result.ok) {
      const detail = clip(
        `smoke fail · exit=${result.code}` +
          (result.timedOut ? " timeout" : "") +
          (result.stderr ? ` · stderr: ${result.stderr}` : "") +
          (result.stdout ? ` · stdout: ${result.stdout}` : ""),
        1200,
      );
      appendLog({
        actor: "forge",
        event: "forge",
        skill: skillSlug,
        decision: "fail",
        charterHash,
        detail,
      });
      return { ok: false, detail };
    }

    const validated = validateHttpOutput(result.stdout);
    if (!validated.ok) {
      const detail = clip(
        `smoke fail · schema_invalid: ${validated.reason} · stdout: ${result.stdout}`,
        1200,
      );
      appendLog({
        actor: "forge",
        event: "forge",
        skill: skillSlug,
        decision: "fail",
        charterHash,
        detail,
      });
      return { ok: false, detail };
    }

    if (opts.defaultsHint === "listings.http_scrape") {
      const items = validated.data.items;
      const hubs = items.filter((it) =>
        isListingHub(String(it.title ?? ""), String(it.url ?? "")),
      );
      const vehicles = items.length - hubs.length;
      if (vehicles < 1) {
        const detail = clip(
          `smoke fail · listings_hubs_only · ${items.length} items (${hubs.length} hubs) · stdout: ${result.stdout}`,
          1200,
        );
        appendLog({
          actor: "forge",
          event: "forge",
          skill: skillSlug,
          decision: "fail",
          charterHash,
          detail,
        });
        return { ok: false, detail };
      }
    }

    const detail = `smoke pass · ${validated.data.items.length} items`;
    appendLog({
      actor: "forge",
      event: "forge",
      skill: skillSlug,
      decision: "pass",
      charterHash,
      detail,
    });
    return { ok: true, detail };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
