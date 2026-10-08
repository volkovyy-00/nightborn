import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (package root). `.env` and `public/` resolve here. */
export const REPO_ROOT = path.resolve(here, "..");

/** Cwd for charter.md + surgery.log (may be staging/ui-dev for UI feed). */
export function dataRoot(): string {
  return process.cwd();
}

export function repoPath(...parts: string[]): string {
  return path.join(REPO_ROOT, ...parts);
}

export function dataPath(...parts: string[]): string {
  return path.join(dataRoot(), ...parts);
}
