import { mkdir, readFile, appendFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { repoPath } from "./paths.ts";

/** Long-term agent memory as markdown under a safe root (`memory/`). */
export class MemoryStore {
  readonly root: string;

  constructor(root: string = repoPath("memory")) {
    this.root = path.resolve(root);
  }

  /**
   * Resolve a relative memory path under the store root.
   * Rejects absolute paths and any `..` escape outside the root.
   */
  resolveSafe(relPath: string): string {
    if (typeof relPath !== "string" || !relPath.trim()) {
      throw new Error("memory path must be a non-empty relative string");
    }
    if (path.isAbsolute(relPath)) {
      throw new Error(`memory path must be relative (got absolute: ${relPath})`);
    }
    // Normalize separators; reject explicit .. segments before resolve
    const normalized = path.normalize(relPath);
    const parts = normalized.split(path.sep).filter((p) => p.length > 0 && p !== ".");
    if (parts.some((p) => p === "..")) {
      throw new Error(`memory path escapes root (contains ..): ${relPath}`);
    }
    const resolved = path.resolve(this.root, ...parts);
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`memory path escapes root: ${relPath}`);
    }
    return resolved;
  }

  /** Read a markdown file; `null` if missing. */
  async read(relPath: string): Promise<string | null> {
    const abs = this.resolveSafe(relPath);
    try {
      await access(abs);
    } catch {
      return null;
    }
    return readFile(abs, "utf8");
  }

  /** Write (create/overwrite) markdown; creates parent dirs. */
  async write(relPath: string, markdown: string): Promise<void> {
    const abs = this.resolveSafe(relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, markdown, "utf8");
  }

  /**
   * Append one line to today's journal file (`journal/YYYY-MM-DD.md`).
   * Creates the file/dirs if needed. Ensures a trailing newline.
   */
  async appendJournal(line: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const rel = path.join("journal", `${day}.md`);
    const abs = this.resolveSafe(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const text = line.endsWith("\n") ? line : `${line}\n`;
    await appendFile(abs, text, "utf8");
  }
}

/** Default store rooted at `<repo>/memory`. */
export const memoryStore = new MemoryStore();
