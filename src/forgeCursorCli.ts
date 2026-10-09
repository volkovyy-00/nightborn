/**
 * Forge via Cursor Agent CLI (`agent` binary) — login session, no API key.
 * Prompt asks for JSON ForgeArtifact; host still runs Warden/Test/Install.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requestToolkitAccess, skillComposioUserId } from "./composio.ts";
import { buildForgeComposioCatalog } from "./forgeComposioCatalog.ts";
import {
  finishForgeDebug,
  forgeAuthoritativeAskPrefix,
  sessionFromCtx,
  writeForgeDebug,
} from "./forgeDebug.ts";
import { smokeTestForgeArtifact } from "./forgeSmokeTest.ts";
import { extractJsonValue, unwrapResultEnvelope } from "./planner/parse.ts";
import type { ForgeArtifact, ForgeContext } from "./types.ts";
import { REPO_ROOT } from "./paths.ts";

const execFileAsync = promisify(execFile);

const FORGE_CLI_RULES = [
  "You are Nightborn's Forge.",
  "Reply with ONLY one JSON object (no markdown fences, no prose before or after).",
  "Either emit a skill OR request Composio access:",
  'A) Skill: name, purpose, query, capabilities, skillSource, optional composioToolkit (e.g. "apify").',
  'B) Access: { "needs_composio_access": true, "toolkit": "apify", "why": "..." } for hard scrapes/Actors.',
  "skillSource HARD RULES:",
  "- No imports. No require. No export default. Use global fetch.",
  "- Read ALL of process.stdin as JSON: { query, baseUrl?, composioProxyUrl? }",
  "- Write ONE JSON object to process.stdout: { items:[{title,url,date?}] }",
  "- Composio-backed: POST {tool,arguments} to input.composioProxyUrl; never COMPOSIO_API_KEY in source.",
  "- When COMPOSIO_TOOLS / APIFY_ACTORS are listed in the prompt: use ONLY those tool slugs and actorIds — never invent APIFY_* or owner~actor names.",
  "- process.env.BRAVE_API_KEY (or TAVILY_API_KEY). AbortSignal.timeout(6000).",
  "- NEVER string literals starting with / — use String.fromCharCode(47) for path joins.",
  "- NEVER put / inside a regex literal (JSON escaping yields SyntaxError: Invalid regular expression flags). Prefer String.includes / indexOf, or new RegExp(\"marketplace|item\").",
  "- Forums/deals → Brave web search; company news → news search; LinkedIn/Actors → needs_composio_access apify.",
  "- listings.http_scrape: site:<siteHost> search; drop shopping-index hubs; retry year+make until vehicle cards remain.",
  "- NEVER dial Bland / run the skill. notify:phone skills must dry-run when NIGHTBORN_BLOCK_OUTBOUND=1 (no fetch to api.bland.ai).",
].join("\n");

function buildForgePrompt(
  intent: string,
  query: string,
  proposedName?: string | null,
  ctx?: ForgeContext | null,
): string {
  const hint = proposedName ? `\nproposedName=${JSON.stringify(proposedName)}` : "";
  const scope = ctx
    ? [
        ctx.skillName != null ? `\nskillName=${JSON.stringify(ctx.skillName)}` : "",
        ctx.requestId != null ? `\nrequestId=${JSON.stringify(ctx.requestId)}` : "",
        ctx.defaultsHint != null ? `\ndefaultsHint=${JSON.stringify(ctx.defaultsHint)}` : "",
        ctx.siteHost != null ? `\nsiteHost=${JSON.stringify(ctx.siteHost)}` : "",
        ctx.minimalSuccess != null
          ? `\nminimalSuccess=${JSON.stringify(ctx.minimalSuccess)}`
          : "",
      ].join("")
    : "";
  return (
    `${FORGE_CLI_RULES}\n` +
    `${forgeAuthoritativeAskPrefix(ctx)}` +
    `intent=${JSON.stringify(intent)}\n` +
    `query=${JSON.stringify(query)}${hint}${scope}\n` +
    `Emit the JSON object now.`
  );
}

/** Follow-up when toolkit is already connected but first reply was access-only. */
function buildSkillAfterComposioPrompt(
  intent: string,
  query: string,
  toolkit: string,
  proposedName?: string | null,
  ctx?: ForgeContext | null,
  catalog?: string,
): string {
  const name =
    proposedName?.trim() || ctx?.skillName?.trim() || "forged_skill";
  const ask = (ctx?.userAsk?.trim() || intent || query).trim();
  const catalogBlock = catalog?.trim()
    ? `\n${catalog.trim()}\n`
    : "";
  return (
    `${FORGE_CLI_RULES}\n` +
    `${forgeAuthoritativeAskPrefix(ctx)}` +
    `Composio toolkit ${JSON.stringify(toolkit)} is ALREADY connected for skill ${JSON.stringify(name)}.\n` +
    `Do NOT return needs_composio_access again.\n` +
    `Return skill JSON with skillSource + composioToolkit=${JSON.stringify(toolkit)}.\n` +
    catalogBlock +
    `intent=${JSON.stringify(intent)}\n` +
    `query=${JSON.stringify(query)}\n` +
    `userAsk=${JSON.stringify(ask)}\n` +
    `proposedName=${JSON.stringify(name)}\n` +
    `Emit the skill JSON object now.`
  );
}

/** One fix pass after host smoke test failed. */
function buildSkillFixAfterSmokePrompt(
  intent: string,
  query: string,
  toolkit: string,
  proposedName: string | null | undefined,
  ctx: ForgeContext | null | undefined,
  catalog: string,
  smokeError: string,
): string {
  const name =
    proposedName?.trim() || ctx?.skillName?.trim() || "forged_skill";
  const ask = (ctx?.userAsk?.trim() || intent || query).trim();
  return (
    `${FORGE_CLI_RULES}\n` +
    `${forgeAuthoritativeAskPrefix(ctx)}` +
    `Composio toolkit ${JSON.stringify(toolkit)} is connected for skill ${JSON.stringify(name)}.\n` +
    `The previous skillSource FAILED the host smoke test. Fix it and emit skill JSON again.\n` +
    `SMOKE_ERROR=${JSON.stringify(smokeError.slice(0, 900))}\n` +
    `Prefer COMPOSIO_TOOLS sync dataset tools (e.g. APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS) over async APIFY_RUN_ACTOR when listed.\n` +
    `If SMOKE_ERROR mentions a required input field (e.g. startUrls), EVERY APIFY_RUN_ACTOR for that actor MUST include it — read ACTOR_INPUT_HINTS.\n` +
    `If SMOKE_ERROR is SyntaxError / Invalid regular expression flags: remove / from regex literals; use includes() or new RegExp without slash delimiters.\n` +
    `Parse Composio proxy JSON carefully (ok/data/run id fields). actorId only from APIFY_ACTORS.\n` +
    `Do NOT return needs_composio_access. Do NOT invent tool slugs or actorIds.\n` +
    (catalog.trim() ? `\n${catalog.trim()}\n` : "") +
    `intent=${JSON.stringify(intent)}\n` +
    `query=${JSON.stringify(query)}\n` +
    `userAsk=${JSON.stringify(ask)}\n` +
    `proposedName=${JSON.stringify(name)}\n` +
    `Emit the fixed skill JSON object now.`
  );
}

function clipPreview(text: string, n = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "(empty)";
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function previewFromStdout(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const env = JSON.parse(trimmed) as { result?: unknown };
    if (typeof env.result === "string") return clipPreview(env.result);
  } catch {
    /* raw */
  }
  return clipPreview(trimmed);
}

export function asAccessRequest(o: unknown): { toolkit: string; why: string } | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.needs_composio_access !== true) return null;
  const toolkit = typeof r.toolkit === "string" ? r.toolkit.trim() : "";
  if (!toolkit) return null;
  return {
    toolkit,
    why: typeof r.why === "string" ? r.why : "Forge needs Composio access",
  };
}

function asArtifact(o: unknown): ForgeArtifact | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.skillSource !== "string" || !r.skillSource.trim()) return null;
  const caps = Array.isArray(r.capabilities)
    ? r.capabilities.filter((c): c is string => typeof c === "string")
    : ["net:fetch"];
  const name =
    typeof r.name === "string" && r.name.trim() ? r.name.trim() : "forged_skill";
  const toolkit =
    typeof r.composioToolkit === "string" ? r.composioToolkit.trim().toLowerCase() : "";
  return {
    name,
    purpose: typeof r.purpose === "string" ? r.purpose : "",
    query: typeof r.query === "string" ? r.query : "",
    capabilities: caps.length ? caps : ["net:fetch"],
    skillSource: r.skillSource,
    ...(toolkit
      ? { composio: { toolkit, userId: skillComposioUserId(name) } }
      : {}),
  };
}

/**
 * Unwrap agent --output-format json envelope (or raw JSON), tolerating prose
 * before the forge object inside envelope.result.
 */
export function parseAgentForgePayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("forge_invalid: empty agent stdout");
  try {
    return unwrapResultEnvelope(extractJsonValue(trimmed));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `forge_invalid: agent stdout not JSON (${why}) · ${previewFromStdout(trimmed)}`,
    );
  }
}

/** Unwrap agent stdout into a ForgeArtifact (skillSource required). */
export function parseAgentForgeStdout(stdout: string): ForgeArtifact {
  const payload = parseAgentForgePayload(stdout);
  const art = asArtifact(payload);
  if (!art) {
    throw new Error(
      `forge_invalid: no skillSource in agent result · ${previewFromStdout(stdout)}`,
    );
  }
  return art;
}

async function runAgentCli(
  prompt: string,
): Promise<{ stdout: string; stderr: string }> {
  const bin = process.env.FORGE_AGENT_BIN?.trim() || "agent";
  const model = process.env.FORGE_AGENT_MODEL?.trim();
  const args = [
    "--print",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--trust",
    "--workspace",
    REPO_ROOT,
  ];
  if (model) args.push("--model", model);
  args.push(prompt);

  const env = { ...process.env };
  delete env.CURSOR_API_KEY;

  try {
    const r = await execFileAsync(bin, args, {
      cwd: REPO_ROOT,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 600_000,
      env,
    });
    return { stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string; code?: number };
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? "";
    const detail = (e.stderr || e.stdout || e.message || "").slice(0, 400);
    throw Object.assign(
      new Error(`forge_invalid: agent CLI failed (${e.code ?? "?"}): ${detail}`),
      { stdout, stderr },
    );
  }
}

function finalizeArtifact(
  captured: ForgeArtifact,
  intent: string,
  query: string,
  proposedName: string | null | undefined,
  sanitizeSkillSource: (s: string) => string,
  ensureRunnableSkillSource: (a: ForgeArtifact, intent: string) => ForgeArtifact,
): ForgeArtifact {
  let art = captured;
  if (proposedName) art = { ...art, name: proposedName };
  if (!art.query) art = { ...art, query };
  art = {
    ...art,
    skillSource: sanitizeSkillSource(art.skillSource!),
  };
  return ensureRunnableSkillSource(art, intent);
}

export async function forgeSkillViaCursorCli(
  intent: string,
  query: string,
  proposedName?: string | null,
  ctx?: ForgeContext | null,
): Promise<ForgeArtifact> {
  const dbg = sessionFromCtx(ctx ?? undefined, "cursor");
  let debugFinished = false;
  const doneDebug = (opts?: { promptBytes?: number; stdoutBytes?: number; error?: string }) => {
    if (debugFinished) return;
    debugFinished = true;
    finishForgeDebug(dbg, opts);
  };
  const prompt = buildForgePrompt(intent, query, proposedName, ctx);
  writeForgeDebug(dbg, "prompt.txt", prompt);

  let stdout = "";
  let stderr = "";
  try {
    try {
      const r = await runAgentCli(prompt);
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      writeForgeDebug(dbg, "stdout.txt", stdout);
      writeForgeDebug(dbg, "stderr.txt", stderr);
      doneDebug({
        promptBytes: prompt.length,
        stdoutBytes: stdout.length,
        error: e.message,
      });
      throw err;
    }

    writeForgeDebug(dbg, "stdout.txt", stdout);
    if (stderr) writeForgeDebug(dbg, "stderr.txt", stderr);

    if (stderr?.trim() && /not logged in|unauthorized|auth/i.test(stderr)) {
      const msg = `forge_invalid: agent auth — run \`agent login\` (${stderr.slice(0, 200)})`;
      doneDebug({
        promptBytes: prompt.length,
        stdoutBytes: stdout.length,
        error: msg,
      });
      throw new Error(msg);
    }

    const {
      NeedsComposioAccessError,
      NeedsSkillAfterComposioError,
      ensureRunnableSkillSource,
      sanitizeSkillSource,
    } = await import("./forge.ts");

    let payload = parseAgentForgePayload(stdout);
    const access = asAccessRequest(payload);
    let connectedToolkit: string | null = null;

    if (access) {
      writeForgeDebug(dbg, "result.json", access);
      const skillName =
        proposedName?.trim() || ctx?.skillName?.trim() || "forged_skill";
      const requestId = ctx?.requestId?.trim() || `forge_${skillName}`;
      const goalId = ctx?.goalId?.trim() || "goal_forge";
      const result = await requestToolkitAccess({
        toolkit: access.toolkit,
        requestId,
        goalId,
        skillName,
        why: access.why,
      });
      if (!result.ok) {
        const msg = `forge_invalid: composio access ${result.code}: ${result.message} · ${previewFromStdout(stdout)}`;
        doneDebug({
          promptBytes: prompt.length,
          stdoutBytes: stdout.length,
          error: msg,
        });
        throw new Error(msg);
      }
      if (!result.alreadyConnected) {
        doneDebug({
          promptBytes: prompt.length,
          stdoutBytes: stdout.length,
        });
        throw new NeedsComposioAccessError({
          toolkit: result.toolkit,
          requestId: result.requestId,
          skillName,
          redirectUrl: result.redirectUrl,
          why: access.why,
        });
      }
      connectedToolkit = result.toolkit;
    }

    let captured = asArtifact(payload);

    // Already connected but access-only JSON — one follow-up for skillSource.
    if (!captured && connectedToolkit) {
      const skillNameForCatalog =
        proposedName?.trim() || ctx?.skillName?.trim() || "forged_skill";
      const askForCatalog = (ctx?.userAsk?.trim() || intent || query).trim();
      let catalog = "";
      try {
        catalog = await buildForgeComposioCatalog(skillNameForCatalog, askForCatalog);
      } catch (err) {
        catalog = `COMPOSIO_TOOLS:\n(catalog build failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      const skillPrompt = buildSkillAfterComposioPrompt(
        intent,
        query,
        connectedToolkit,
        proposedName,
        ctx,
        catalog,
      );
      writeForgeDebug(dbg, "prompt_reprompt.txt", skillPrompt);
      let repStdout = "";
      try {
        const r = await runAgentCli(skillPrompt);
        repStdout = r.stdout;
        writeForgeDebug(dbg, "stdout_reprompt.txt", repStdout);
        if (r.stderr) writeForgeDebug(dbg, "stderr_reprompt.txt", r.stderr);
        payload = parseAgentForgePayload(repStdout);
        captured = asArtifact(payload);
        stdout = repStdout;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        doneDebug({
          promptBytes: prompt.length + skillPrompt.length,
          stdoutBytes: repStdout.length || stdout.length,
          error: detail,
        });
        throw new NeedsSkillAfterComposioError({
          toolkit: connectedToolkit,
          skillName: proposedName?.trim() || ctx?.skillName?.trim() || "forged_skill",
          detail,
        });
      }
      if (!captured) {
        const detail = previewFromStdout(repStdout || stdout);
        doneDebug({
          promptBytes: prompt.length + skillPrompt.length,
          stdoutBytes: (repStdout || stdout).length,
          error: `needs_skill_after_composio · ${detail}`,
        });
        throw new NeedsSkillAfterComposioError({
          toolkit: connectedToolkit,
          skillName: proposedName?.trim() || ctx?.skillName?.trim() || "forged_skill",
          detail,
        });
      }
      // Ensure composio binding on artifact if agent omitted composioToolkit.
      if (!captured.composio) {
        const name = proposedName?.trim() || captured.name;
        captured = {
          ...captured,
          name,
          composio: {
            toolkit: connectedToolkit,
            userId: skillComposioUserId(name),
          },
        };
      }
    }

    if (!captured) {
      const msg = `forge_invalid: no skillSource in agent result · ${previewFromStdout(stdout)}`;
      doneDebug({
        promptBytes: prompt.length,
        stdoutBytes: stdout.length,
        error: msg,
      });
      throw new Error(msg);
    }

    let out = finalizeArtifact(
      captured,
      intent,
      query,
      proposedName,
      sanitizeSkillSource,
      ensureRunnableSkillSource,
    );

    const skillNameForSmoke =
      proposedName?.trim() || ctx?.skillName?.trim() || out.name || "forged_skill";
    // Prefer verbatim user ask so Marketplace skills build real search URLs.
    const testQuery =
      ctx?.userAsk?.trim() || out.query?.trim() || query;
    let smoke = await smokeTestForgeArtifact({
      artifact: out,
      skillName: skillNameForSmoke,
      testQuery,
      defaultsHint: ctx?.defaultsHint,
    });
    writeForgeDebug(dbg, "smoke1.txt", smoke.detail);

    if (!smoke.ok && (out.composio || connectedToolkit)) {
      const toolkit = out.composio?.toolkit || connectedToolkit || "apify";
      const askForCatalog = (ctx?.userAsk?.trim() || intent || query).trim();
      let catalog = "";
      try {
        catalog = await buildForgeComposioCatalog(skillNameForSmoke, askForCatalog);
      } catch (err) {
        catalog = `COMPOSIO_TOOLS:\n(catalog build failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      const runSmokeFix = async (smokeError: string, tag: string) => {
        const fixPrompt = buildSkillFixAfterSmokePrompt(
          intent,
          query,
          toolkit,
          proposedName,
          ctx,
          catalog,
          smokeError,
        );
        writeForgeDebug(dbg, `prompt_${tag}.txt`, fixPrompt);
        const r = await runAgentCli(fixPrompt);
        writeForgeDebug(dbg, `stdout_${tag}.txt`, r.stdout);
        if (r.stderr) writeForgeDebug(dbg, `stderr_${tag}.txt`, r.stderr);
        const fixPayload = parseAgentForgePayload(r.stdout);
        let fixed = asArtifact(fixPayload);
        if (!fixed) return r.stdout;
        if (!fixed.composio && toolkit) {
          const name = proposedName?.trim() || fixed.name;
          fixed = {
            ...fixed,
            name,
            composio: {
              toolkit,
              userId: skillComposioUserId(name),
            },
          };
        }
        out = finalizeArtifact(
          fixed,
          intent,
          query,
          proposedName,
          sanitizeSkillSource,
          ensureRunnableSkillSource,
        );
        smoke = await smokeTestForgeArtifact({
          artifact: out,
          skillName: skillNameForSmoke,
          testQuery,
          defaultsHint: ctx?.defaultsHint,
        });
        writeForgeDebug(dbg, tag === "smoke_fix" ? "smoke2.txt" : "smoke3.txt", smoke.detail);
        return r.stdout;
      };
      try {
        stdout = await runSmokeFix(smoke.detail, "smoke_fix");
        // One extra pass when the fix itself is unparsable JS (common: / in regex literals).
        if (
          !smoke.ok &&
          /SyntaxError|Invalid regular expression/i.test(smoke.detail)
        ) {
          stdout = await runSmokeFix(smoke.detail, "smoke_syntax_fix");
        }
      } catch (err) {
        writeForgeDebug(
          dbg,
          "smoke_fix_error.txt",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (!smoke.ok) {
      const msg = `forge_invalid: smoke test failed · ${smoke.detail}`;
      doneDebug({
        promptBytes: prompt.length,
        stdoutBytes: stdout.length,
        error: msg,
      });
      // Do not let Doctor cars.com-scaffold over a failed Composio skill.
      if (out.composio || connectedToolkit) {
        throw new NeedsSkillAfterComposioError({
          toolkit: out.composio?.toolkit || connectedToolkit || "apify",
          skillName: skillNameForSmoke,
          detail: smoke.detail,
        });
      }
      throw new Error(msg);
    }

    writeForgeDebug(dbg, "result.json", {
      name: out.name,
      purpose: out.purpose,
      query: out.query,
      capabilities: out.capabilities,
      skillSourceLen: out.skillSource?.length ?? 0,
      composio: out.composio ?? null,
      smoke: smoke.detail,
    });
    doneDebug({
      promptBytes: prompt.length,
      stdoutBytes: stdout.length,
    });
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    doneDebug({
      promptBytes: prompt.length,
      stdoutBytes: stdout.length,
      error:
        code === "needs_composio_access" || code === "needs_skill_after_composio"
          ? undefined
          : msg,
    });
    throw err;
  }
}
