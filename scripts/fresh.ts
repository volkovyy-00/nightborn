import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/paths.ts";

const cwd = process.cwd();
const ts = new Date().toISOString().replace(/[:.]/g, "-");
for (const name of ["surgery.log", "surgery.smoke.log", "surgery.fixture.log"]) {
  const logPath = path.join(cwd, name);
  if (existsSync(logPath)) {
    const base = name.replace(/\.log$/, "");
    renameSync(logPath, path.join(cwd, `${base}.${ts}.log`));
  }
}

const staging = path.join(cwd, "staging");
if (existsSync(staging)) {
  for (const name of readdirSync(staging)) {
    rmSync(path.join(staging, name), { recursive: true, force: true });
  }
}

const skills = path.join(cwd, "skills");
if (existsSync(skills)) {
  for (const name of readdirSync(skills)) {
    if (name === "hand_probe") continue;
    const p = path.join(skills, name);
    if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
  }
}

mkdirSync(path.join(REPO_ROOT, "staging"), { recursive: true });
console.log("fresh: rotated log, wiped staging + forged skills (kept hand_probe if present)");
