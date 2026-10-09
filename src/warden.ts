import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import type { DecisionJson, FailureCode, Job, Manifest } from "./types.ts";
import { folderHash } from "./hash.ts";
import { getCharterHash } from "./charter.ts";
import { appendLog } from "./log.ts";
import { grantKeysForCaps, setProvisionalGrant, clearProvisionalGrant } from "./broker.ts";

export type WardenResult =
  | { ok: true; caps: string[]; folderHash: string }
  | { ok: false; failureCode: FailureCode; caps: string[]; detail: string };

function scanCapabilities(src: string): { caps: Set<string>; hardFail?: FailureCode; detail?: string } {
  const caps = new Set<string>();
  if (/\beval\s*\(|new\s+Function\b|import\s*\(/.test(src)) {
    return { caps, hardFail: "forbidden_construct", detail: "forbidden_construct" };
  }

  if (/\bfetch\s*\(|\bhttps?:\/\/|\bundici\b|\baxios\b/.test(src)) caps.add("net:fetch");
  if (/process\.env(?:\.|\[)["']?(TAVILY_API_KEY|BRAVE_API_KEY|APIFY_TOKEN)/.test(src)) {
    caps.add("net:fetch");
  }
  if (/process\.env(?:\.|\[)["']?BLAND_API_KEY/.test(src)) caps.add("notify:phone");
  if (/process\.env\.OPENAI_API_KEY|\bfrom\s+['"]openai['"]|require\(['"]openai['"]\)/.test(src)) {
    caps.add("llm:call");
  }
  if (/nodemailer|\bsmtp\b/i.test(src)) caps.add("notify:email");
  if (/\bwriteFile|\bappendFile|\bcreateWriteStream|\brenameSync|\bunlink/.test(src)) {
    caps.add("fs:write_own");
  }
  if (/\breadFile|\bcreateReadStream|\breaddir/.test(src)) caps.add("fs:read_own");

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

  const required = new Set<string>([...scan.caps, ...manifest.capabilities, ...job.needs]);
  const caps = [...required];

  // Email DENIED specimen only — all other caps install for MVP showcase.
  if (required.has("notify:email")) {
    return {
      ok: false,
      failureCode: "capability_not_allowed",
      caps: ["notify:email"],
      detail: "triggers: scan:nodemailer",
    };
  }

  const h1 = folderHash(runDir);

  if (!opts?.skipLogPrecheck) {
    appendLog({
      actor: "warden",
      event: "precheck",
      skill: skillName,
      decision: "allow",
      charterHash: getCharterHash(),
      caps,
      detail: `caps ${caps.join(",") || "(none)"}`,
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
  composio?: DecisionJson["composio"],
): DecisionJson {
  const dest = path.join(skillsRoot, skillName);
  mkdirSync(skillsRoot, { recursive: true });
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(runDir, dest, { recursive: true });

  const isCall = caps.includes("notify:phone");
  const provider = (process.env.SEARCH_PROVIDER ?? "brave").toLowerCase() as "brave" | "tavily";
  const installedCaps = [...new Set(caps.filter((c) => c !== "notify:email"))];
  const decision: DecisionJson = {
    skill: skillName,
    template: isCall ? "call" : "http",
    provider: isCall
      ? null
      : composio?.toolkit === "apify"
        ? "apify"
        : provider === "tavily"
          ? "tavily"
          : "brave",
    folderHash: folderH,
    charterHash: getCharterHash(),
    capabilities: installedCaps,
    env: grantKeysForCaps(installedCaps),
    decidedAt: new Date().toISOString(),
    ...(composio ? { composio } : {}),
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
    detail: composio
      ? `installed ${skillName} · composio=${composio.toolkit} userId=${composio.userId}`
      : `installed ${skillName}`,
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
