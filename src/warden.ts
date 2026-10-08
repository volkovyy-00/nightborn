import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { DecisionJson, FailureCode, Job, Manifest } from "./types.ts";
import { folderHash } from "./hash.ts";
import { getCharterHash, isAllowedCap } from "./charter.ts";
import { appendLog } from "./log.ts";
import { grantKeysForCaps, setProvisionalGrant, clearProvisionalGrant } from "./broker.ts";

export type WardenResult =
  | { ok: true; caps: string[]; folderHash: string }
  | { ok: false; failureCode: FailureCode; caps: string[]; detail: string };

/** Frozen protected_path pattern — SPEC §8. */
const PROTECTED = /charter\.md|\.\.\/|\.env|broker|^\//;

function walkStringLits(src: string): string[] {
  const sf = ts.createSourceFile("skill.mjs", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text);
      for (const span of node.templateSpans) out.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function scanCapabilities(src: string): { caps: Set<string>; hardFail?: FailureCode; detail?: string } {
  const caps = new Set<string>();
  if (/\beval\s*\(|new\s+Function\b|import\s*\(/.test(src)) {
    return { caps, hardFail: "forbidden_construct", detail: "forbidden_construct" };
  }

  for (const lit of walkStringLits(src)) {
    if (PROTECTED.test(lit) || lit.startsWith("/")) {
      return { caps, hardFail: "protected_path", detail: `protected_path:${lit.slice(0, 80)}` };
    }
  }

  if (/\bfetch\s*\(|\bhttps?:\/\/|\bundici\b|\baxios\b/.test(src)) caps.add("net:fetch");
  if (/process\.env\.(TAVILY_API_KEY|BRAVE_API_KEY|APIFY_TOKEN)/.test(src)) caps.add("net:fetch");
  if (/process\.env\.BLAND_API_KEY/.test(src)) caps.add("notify:phone");
  if (/process\.env\.OPENAI_API_KEY|\bfrom\s+['"]openai['"]|require\(['"]openai['"]\)/.test(src)) {
    caps.add("llm:call");
  }
  if (/nodemailer|\bsmtp\b/i.test(src)) caps.add("notify:email");
  if (/\bwriteFile|\bappendFile|\bcreateWriteStream|\brenameSync|\bunlink/.test(src)) {
    caps.add("fs:write_own");
  }
  if (/\breadFile|\bcreateReadStream|\breaddir/.test(src)) caps.add("fs:read_own");

  const envAccess = [...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  const known = new Set([
    "TAVILY_API_KEY",
    "BRAVE_API_KEY",
    "APIFY_TOKEN",
    "BLAND_API_KEY",
    "OPENAI_API_KEY",
  ]);
  for (const k of envAccess) {
    if (!known.has(k)) caps.add("secrets:read");
  }
  // computed / bracket access → secrets:read (except ENV_KEY pattern used by templates)
  if (/process\.env\s*[^\.\[]|process\.env\s*\[/.test(src)) {
    // templates use process.env[ENV_KEY] for BRAVE/TAVILY — treat as net:fetch already via ENV_KEY const
    if (!/process\.env\[ENV_KEY\]/.test(src)) caps.add("secrets:read");
  }
  return { caps };
}

export function wipeStaging(runDir: string): void {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function wardenPre(
  runDir: string,
  job: Job,
  skillName: string,
  opts?: { skipLogPrecheck?: boolean },
): WardenResult {
  const skillPath = path.join(runDir, "skill.mjs");
  const manifestPath = path.join(runDir, "manifest.json");
  if (!existsSync(skillPath) || !existsSync(manifestPath)) {
    return { ok: false, failureCode: "forge_invalid", caps: [], detail: "missing skill files" };
  }
  const src = readFileSync(skillPath, "utf8");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const scan = scanCapabilities(src);
  if (scan.hardFail) {
    return { ok: false, failureCode: scan.hardFail, caps: [...scan.caps], detail: scan.detail ?? scan.hardFail };
  }

  const triggers: string[] = [];
  const required = new Set<string>([...scan.caps, ...manifest.capabilities, ...job.needs]);

  for (const n of job.needs) {
    if (!isAllowedCap(n)) triggers.push("job_needs");
  }
  for (const c of manifest.capabilities) {
    if (!isAllowedCap(c)) triggers.push("manifest");
  }
  for (const c of scan.caps) {
    if (!isAllowedCap(c)) {
      if (c === "notify:email") triggers.push("scan:nodemailer");
      else triggers.push(`scan:${c}`);
    }
  }

  const denied = [...required].filter((c) => !isAllowedCap(c));
  const caps = [...required];
  const h1 = folderHash(runDir);

  if (denied.length > 0) {
    const uniq = [...new Set(triggers)];
    return {
      ok: false,
      failureCode: "capability_not_allowed",
      caps: denied,
      detail: `triggers: ${uniq.join(", ") || denied.join(",")}`,
    };
  }

  if (!opts?.skipLogPrecheck) {
    appendLog({
      actor: "warden",
      event: "precheck",
      skill: skillName,
      decision: "allow",
      charterHash: getCharterHash(),
      caps,
      detail: `caps ${caps.join(",")} ⊆ charter`,
    });
  }

  setProvisionalGrant(grantKeysForCaps(caps));
  return { ok: true, caps, folderHash: h1 };
}

export function denyAndWipe(
  runDir: string,
  skillName: string,
  failureCode: FailureCode,
  caps: string[],
  detail: string,
): void {
  appendLog({
    actor: "warden",
    event: "denied",
    skill: skillName,
    decision: "deny",
    failureCode,
    charterHash: getCharterHash(),
    caps,
    voice: "voice/denied.wav",
    detail,
  });
  clearProvisionalGrant();
  wipeStaging(runDir);
}

export function wardenFinal(
  runDir: string,
  skillName: string,
  preHash: string,
  caps: string[],
): WardenResult {
  const h2 = folderHash(runDir);
  if (h2 !== preHash) {
    return { ok: false, failureCode: "hash_mismatch", caps, detail: "FINAL hash != PRE" };
  }
  appendLog({
    actor: "warden",
    event: "final",
    skill: skillName,
    decision: "allow",
    charterHash: getCharterHash(),
    caps,
    detail: "FINAL = PRE",
  });
  return { ok: true, caps, folderHash: h2 };
}

export function installSkill(
  runDir: string,
  skillName: string,
  caps: string[],
  folderH: string,
  skillsRoot: string,
): DecisionJson {
  const dest = path.join(skillsRoot, skillName);
  mkdirSync(skillsRoot, { recursive: true });
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(runDir, dest, { recursive: true });

  const isCall = caps.includes("notify:phone");
  const provider = (process.env.SEARCH_PROVIDER ?? "brave").toLowerCase() as "brave" | "tavily";
  const allowedCaps = [...new Set(caps.filter((c) => isAllowedCap(c)))];
  const decision: DecisionJson = {
    skill: skillName,
    template: isCall ? "call" : "http",
    provider: isCall ? null : provider === "tavily" ? "tavily" : "brave",
    folderHash: folderH,
    charterHash: getCharterHash(),
    capabilities: allowedCaps,
    env: grantKeysForCaps(allowedCaps),
    decidedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dest, "decision.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  appendLog({
    actor: "warden",
    event: "install",
    skill: skillName,
    decision: "allow",
    charterHash: getCharterHash(),
    caps: decision.capabilities,
    voice: "voice/install.wav",
    detail: `installed ${skillName}`,
  });
  clearProvisionalGrant();
  wipeStaging(runDir);
  return decision;
}

export function checkReuseHashes(skillDir: string, decision: DecisionJson): FailureCode | null {
  const h = folderHash(skillDir);
  if (h !== decision.folderHash) return "hash_mismatch";
  if (decision.charterHash !== getCharterHash()) return "hash_mismatch";
  return null;
}
