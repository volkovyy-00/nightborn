import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export function toLF(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
}

export function stripBOM(bytes: Buffer): Buffer {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Charter pin recipe: sha256("nightborn-charter-v1\n" + toLF(stripBOM(bytes))) */
export function charterHashFromBytes(bytes: Buffer): string {
  const body = toLF(stripBOM(bytes));
  return sha256Hex(Buffer.concat([Buffer.from("nightborn-charter-v1\n", "utf8"), body]));
}

export function shortHash(full: string): string {
  return full.slice(0, 8);
}

const HASH_FILES = ["skill.mjs", "notes.md", "manifest.json"] as const;

/** Folder hash: sorted relpath \\0 sha256(bytes) \\n over exactly the three files. */
export function folderHash(skillDir: string): string {
  const parts: string[] = [];
  for (const rel of [...HASH_FILES].sort()) {
    const abs = path.join(skillDir, rel);
    const bytes = readFileSync(abs);
    parts.push(`${rel}\0${sha256Hex(bytes)}\n`);
  }
  return sha256Hex(parts.join(""));
}

export function listSkillDirs(skillsRoot: string): string[] {
  try {
    return readdirSync(skillsRoot)
      .filter((name) => {
        if (!/^[a-z0-9_]+$/.test(name)) return false;
        try {
          return statSync(path.join(skillsRoot, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}
