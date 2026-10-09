/**
 * Doctor inbox — file queue for capability briefs.
 *
 * Layout (see doctor/README.md):
 *   doctor/inbox/  pending *.md
 *   doctor/wip/    currently being forged
 *   doctor/done/   success archive
 *   doctor/failed/ failure archive
 *
 * submit() only enqueues (returns immediately). Does not call Forge (T07).
 */

import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoPath } from "../paths.ts";
import { type CapabilityBrief, parseBrief, serializeBrief } from "./brief.ts";

export type DoctorDirs = {
  root: string;
  inbox: string;
  wip: string;
  done: string;
  failed: string;
};

export function doctorDirs(root: string = repoPath("doctor")): DoctorDirs {
  const abs = path.resolve(root);
  return {
    root: abs,
    inbox: path.join(abs, "inbox"),
    wip: path.join(abs, "wip"),
    done: path.join(abs, "done"),
    failed: path.join(abs, "failed"),
  };
}

async function ensureDirs(dirs: DoctorDirs): Promise<void> {
  await Promise.all(
    [dirs.root, dirs.inbox, dirs.wip, dirs.done, dirs.failed].map((d) =>
      mkdir(d, { recursive: true }),
    ),
  );
}

/** Filesystem stem for a requestId — never throws; brief body keeps the original id. */
export function briefFileStem(requestId: string): string {
  const slug = requestId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return slug || "request";
}

function briefFileName(requestId: string): string {
  return `${briefFileStem(requestId)}.md`;
}

function parkedComposioPath(dirs: DoctorDirs, requestId: string): string {
  return path.join(dirs.wip, `${briefFileStem(requestId)}.parked-composio`);
}

/** Mark a WIP brief as parked waiting for Composio Connect (not an active forge). */
export async function markParkedComposio(
  requestId: string,
  root?: string,
): Promise<void> {
  const dirs = doctorDirs(root);
  await ensureDirs(dirs);
  await writeFile(parkedComposioPath(dirs, requestId), "composio\n", "utf8");
}

/** Remove parked-composio sidecar if present. */
export async function clearParkedComposio(
  requestId: string,
  root?: string,
): Promise<void> {
  const dirs = doctorDirs(root);
  try {
    await unlink(parkedComposioPath(dirs, requestId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** True when WIP brief has the parked-composio sidecar. */
export async function isParkedComposio(
  requestId: string,
  root?: string,
): Promise<boolean> {
  const dirs = doctorDirs(root);
  try {
    await access(parkedComposioPath(dirs, requestId));
    return true;
  } catch {
    return false;
  }
}

/** List pending brief filenames (sorted) in a directory. */
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
 * Non-blocking enqueue: write doctor/inbox/<requestId>.md and return immediately.
 * Overwrites if the same requestId is already pending in inbox.
 */
export async function submit(
  brief: CapabilityBrief,
  root?: string,
): Promise<{ requestId: string }> {
  const dirs = doctorDirs(root);
  await ensureDirs(dirs);
  const file = path.join(dirs.inbox, briefFileName(brief.requestId));
  await writeFile(file, serializeBrief(brief), "utf8");
  return { requestId: brief.requestId };
}

/**
 * Dequeue one brief: rename inbox → wip (lexicographically first *.md).
 * Returns null when inbox is empty.
 */
export async function take(root?: string): Promise<CapabilityBrief | null> {
  const dirs = doctorDirs(root);
  await ensureDirs(dirs);
  const pending = await listBriefFiles(dirs.inbox);
  if (pending.length === 0) return null;

  const name = pending[0]!;
  const from = path.join(dirs.inbox, name);
  const to = path.join(dirs.wip, name);
  await rename(from, to);
  const markdown = await readFile(to, "utf8");
  return parseBrief(markdown);
}

/** Mark a wip brief complete: move wip → done (idempotent if already done / reclaim inbox). */
export async function complete(requestId: string, root?: string): Promise<void> {
  await settleBrief(requestId, "done", root);
}

/** Mark a wip brief failed: move wip → failed. */
export async function fail(requestId: string, root?: string): Promise<void> {
  await settleBrief(requestId, "failed", root);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move brief to done/failed.
 * - Prefer WIP.
 * - If WIP missing and dest already has it → no-op (idempotent complete).
 * - If WIP missing and inbox has it (stolen re-queue) → move inbox → dest.
 */
async function settleBrief(
  requestId: string,
  dest: "done" | "failed",
  root: string | undefined,
): Promise<void> {
  const dirs = doctorDirs(root);
  await ensureDirs(dirs);
  const name = briefFileName(requestId);
  const wipPath = path.join(dirs.wip, name);
  const destPath = path.join(dirs[dest], name);
  const inboxPath = path.join(dirs.inbox, name);

  await clearParkedComposio(requestId, root);

  if (await fileExists(wipPath)) {
    await rename(wipPath, destPath);
    return;
  }
  if (await fileExists(destPath)) {
    return;
  }
  if (await fileExists(inboxPath)) {
    await rename(inboxPath, destPath);
    return;
  }
  throw new Error(`doctor inbox: no wip brief for requestId ${requestId}`);
}
