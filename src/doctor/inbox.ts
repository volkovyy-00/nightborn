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

import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
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

function briefFileName(requestId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(requestId)) {
    throw new Error(`doctor inbox: unsafe requestId ${JSON.stringify(requestId)}`);
  }
  return `${requestId}.md`;
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

/** Mark a wip brief complete: move wip → done. */
export async function complete(requestId: string, root?: string): Promise<void> {
  await moveWip(requestId, "done", root);
}

/** Mark a wip brief failed: move wip → failed. */
export async function fail(requestId: string, root?: string): Promise<void> {
  await moveWip(requestId, "failed", root);
}

async function moveWip(
  requestId: string,
  dest: "done" | "failed",
  root: string | undefined,
): Promise<void> {
  const dirs = doctorDirs(root);
  await ensureDirs(dirs);
  const name = briefFileName(requestId);
  const from = path.join(dirs.wip, name);
  const to = path.join(dirs[dest], name);

  try {
    await access(from);
  } catch {
    throw new Error(`doctor inbox: no wip brief for requestId ${requestId}`);
  }
  await rename(from, to);
}
