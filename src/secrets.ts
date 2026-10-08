/**
 * Secrets reload + retry of Doctor briefs parked on needs_secret.
 *
 * Operator flow (MVP):
 * 1. Doctor emits `capability.needs_secret` with `envKeys` and parks the brief in `doctor/wip/`.
 * 2. Add the missing KEY=value lines to repo-root `.env` (never commit real keys).
 * 3. Call `reloadAndRetryParked()` (reload + re-queue + Doctor kick).
 * 4. Doctor finishes Install → `capability.ready`; agent resumes without re-stating the goal.
 *
 * Process restart reloads `.env` on boot but does **not** move parked wip → inbox; after restart
 * call `retryParkedSecretBriefs(parkedIds)` if you kept the ids, or `reloadAndRetryParked()`.
 *
 * Optional `POST /api/secrets/reload` (body-less reload+retry) is server/T09 ownership — not here.
 * Never log secret values.
 */

import { readFileSync } from "node:fs";
import { readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { getDefault } from "./defaults.ts";
import { parseBrief } from "./doctor/brief.ts";
import { doctorDirs } from "./doctor/inbox.ts";
import { kick, missingEnvKeys } from "./doctor/worker.ts";
import { emit } from "./events.ts";
import { REPO_ROOT } from "./paths.ts";

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function stripInlineComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Parse KEY=VALUE lines from a dotenv body. Do not log returned values. */
export function parseDotEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = ENV_LINE.exec(trimmed);
    if (!m) continue;
    out[m[1]!] = unquote(stripInlineComment(m[2] ?? ""));
  }
  return out;
}

function applyParsedEnv(parsed: Record<string, string>): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== value) {
      process.env[key] = value;
      changed.push(key);
    }
  }
  return changed;
}

/**
 * Re-read repo-root `.env` into `process.env`, overwriting keys present in the file.
 * Node's `process.loadEnvFile` does not override existing keys (empty → filled would stick).
 * Returns env **names** that changed — never values. Missing file → [].
 */
export function reloadEnvFromDotfile(envPath: string = path.join(REPO_ROOT, ".env")): string[] {
  let contents: string;
  try {
    contents = readFileSync(envPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return applyParsedEnv(parseDotEnv(contents));
}

async function listBriefFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort();
}

/**
 * requestIds in doctor/wip whose defaults.envKeys are currently missing
 * (Doctor parked these on needs_secret). Safe to call before reload.
 */
export async function listSecretParkedRequestIds(root?: string): Promise<string[]> {
  const dirs = doctorDirs(root);
  const files = await listBriefFiles(dirs.wip);
  const parked: string[] = [];

  for (const name of files) {
    const markdown = await readFile(path.join(dirs.wip, name), "utf8");
    let brief;
    try {
      brief = parseBrief(markdown);
    } catch {
      continue;
    }
    if (!brief.defaultsHint) continue;
    const defaults = getDefault(brief.defaultsHint);
    if (!defaults) continue;
    if (missingEnvKeys(defaults).length === 0) continue;
    parked.push(brief.requestId);
  }
  return parked;
}

/**
 * Wip briefs that look like secret-parks now unblocked: have defaults.envKeys and
 * missingEnvKeys is empty. Call after reloadEnvFromDotfile().
 */
async function listUnblockedSecretParkedRequestIds(root?: string): Promise<string[]> {
  const dirs = doctorDirs(root);
  const files = await listBriefFiles(dirs.wip);
  const ready: string[] = [];

  for (const name of files) {
    const markdown = await readFile(path.join(dirs.wip, name), "utf8");
    let brief;
    try {
      brief = parseBrief(markdown);
    } catch {
      continue;
    }
    if (!brief.defaultsHint) continue;
    const defaults = getDefault(brief.defaultsHint);
    if (!defaults || defaults.envKeys.length === 0) continue;
    if (missingEnvKeys(defaults).length > 0) continue;
    ready.push(brief.requestId);
  }
  return ready;
}

async function moveWipToInbox(requestIds: string[], root?: string): Promise<string[]> {
  const dirs = doctorDirs(root);
  const requeued: string[] = [];

  for (const requestId of requestIds) {
    if (!/^[A-Za-z0-9._-]+$/.test(requestId)) continue;
    const name = `${requestId}.md`;
    const from = path.join(dirs.wip, name);
    const to = path.join(dirs.inbox, name);
    try {
      await rename(from, to);
      requeued.push(requestId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }

  if (requeued.length > 0) {
    kick(root);
  }
  return requeued;
}

/**
 * After `.env` reload: re-queue wip briefs waiting on secrets and kick Doctor.
 * With no ids: moves wip briefs whose defaults.envKeys are now satisfied.
 * Prefer `reloadAndRetryParked()` when Doctor may be forging (pre-reload snapshot).
 */
export async function retryParkedSecretBriefs(
  requestIds?: string[],
  root?: string,
): Promise<string[]> {
  const ids = requestIds ?? (await listUnblockedSecretParkedRequestIds(root));
  return moveWipToInbox(ids, root);
}

/**
 * Snapshot secret-parked briefs → reload `.env` → re-queue those ids → emit secrets.provided.
 */
export async function reloadAndRetryParked(root?: string): Promise<{
  changedKeys: string[];
  requeued: string[];
}> {
  const parkedIds = await listSecretParkedRequestIds(root);
  const changedKeys = reloadEnvFromDotfile();
  const requeued = await moveWipToInbox(parkedIds, root);

  if (changedKeys.length > 0) {
    await emit({ type: "secrets.provided", envKeys: changedKeys });
  }

  return { changedKeys, requeued };
}
