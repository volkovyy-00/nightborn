import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { DecisionJson, FailureCode, Job, Manifest } from "./types.ts";
import { folderHash } from "./hash.ts";
import { getCharter, getCharterHash, isAllowedCap } from "./charter.ts";
import { appendLog } from "./log.ts";
import { BROKER_MAP } from "./broker.ts";

// Warden = deterministic code, no LLM (SPEC §8). Sole writer of decision.json and of `denied` lines.

const BRAVE_HOST = "api.search.brave.com";
const NAME_RE = /^[a-z0-9_]{1,40}$/;
export const PROTECTED = /charter\.md|\.\.\/|\.env|broker|^\//;
export const SECRET = /sk-[A-Za-z0-9_-]{16,}|BSA[A-Za-z0-9_-]{20,}/;
const FORBIDDEN_MODULES = new Set([
  "child_process", "vm", "worker_threads", "net", "tls", "http", "https", "http2", "dgram", "dns", "dns/promises", "module", "undici",
]);
const FORBIDDEN_IDENTS = new Set([
  "getBuiltinModule", "createRequire", "WebSocket", "getOwnPropertySymbols", "Reflect", "dlopen", "binding",
]);
const FS_WRITE = /^(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync)$/;
const FS_READ = /^(readFile|readFileSync|createReadStream|readdir|readdirSync|opendir|opendirSync)$/;

export const DENIED_VOICE = "voice/denied.wav";

export type ScanResult = {
  caps: Set<string>;
  env: Set<string>; // literal process.env.X names
  urlHosts: Set<string>;
  triggers: Set<string>; // scan:<module> for the denied detail (e.g. scan:nodemailer)
  /** `literals`: the offending strings (protected_path / secret_in_file) — for Builder feedback only, never logged. */
  fail?: { code: FailureCode; detail: string; literals?: string[] };
};

/** Static scan over skill.mjs with the TypeScript compiler API (SPEC §8 "Static scan"). */
export function scanSkill(src: string): ScanResult {
  const sf = ts.createSourceFile("skill.mjs", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const r: ScanResult = { caps: new Set(), env: new Set(), urlHosts: new Set(), triggers: new Set() };
  const forbidden: string[] = [];
  const protectedLits: string[] = [];
  const secretLits: string[] = [];

  const onModule = (spec: string) => {
    const bare = spec.replace(/^node:/, "");
    if (FORBIDDEN_MODULES.has(bare)) forbidden.push(`import ${bare}`);
    if (bare === "nodemailer" || bare === "smtp") {
      r.caps.add("notify:email");
      r.triggers.add(`scan:${bare}`);
    }
    if (bare === "openai" || bare.startsWith("@anthropic-ai")) r.caps.add("llm:call");
  };
  const onString = (text: string) => {
    if (PROTECTED.test(text)) protectedLits.push(text);
    if (SECRET.test(text)) secretLits.push(text);
    if (/^https?:\/\//i.test(text)) {
      try {
        r.urlHosts.add(new URL(text).hostname);
      } catch {
        /* not a URL */
      }
    }
  };
  const isProcessEnv = (n: ts.Node): boolean =>
    ts.isPropertyAccessExpression(n) &&
    n.name.text === "env" &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "process";

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) onString(node.text);
    else if (ts.isTemplateExpression(node)) {
      onString(node.head.text);
      for (const span of node.templateSpans) onString(span.literal.text);
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const m = node.moduleSpecifier;
      if (m && ts.isStringLiteral(m)) onModule(m.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) forbidden.push("dynamic import()");
      if (ts.isIdentifier(callee) && callee.text === "eval") forbidden.push("eval");
      if (ts.isIdentifier(callee) && callee.text === "require") {
        if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) onModule(node.arguments[0].text);
        else forbidden.push("require(<computed>)");
      }
      if (ts.isIdentifier(callee) && callee.text === "Function") forbidden.push("Function()");
      if (ts.isIdentifier(callee) && callee.text === "fetch") r.caps.add("net:fetch");
      const fname = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (fname === "fetch" && ts.isPropertyAccessExpression(callee)) r.caps.add("net:fetch");
      if (FS_WRITE.test(fname)) r.caps.add("fs:write_own");
      if (FS_READ.test(fname)) r.caps.add("fs:read_own");
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      forbidden.push("new Function");
    }
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTS.has(node.text)) forbidden.push(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "for" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Symbol"
    ) {
      forbidden.push("Symbol.for");
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["process", "globalThis", "global"].includes(node.expression.text)
    ) {
      forbidden.push(`${node.expression.text}[…]`);
    }
    if (isProcessEnv(node)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const name = parent.name.text;
        r.env.add(name);
        if (name === "BRAVE_API_KEY") r.caps.add("net:fetch");
        else if (name === "OPENROUTER_API_KEY") r.caps.add("llm:call");
        else r.caps.add("secrets:read");
      } else {
        r.caps.add("secrets:read"); // computed, destructuring, or process.env as a value
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (forbidden.length) r.fail = { code: "forbidden_construct", detail: `forbidden: ${forbidden[0]}` };
  else if (protectedLits.length) r.fail = { code: "protected_path", detail: "protected literal", literals: protectedLits };
  else if (secretLits.length) r.fail = { code: "secret_in_file", detail: "key-like literal", literals: secretLits };
  return r;
}

export function wipeStaging(runDir: string): void {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** The single frozen `denied` line (SPEC §11/§12): actor warden, voice, one per DENIED outcome. */
export function wardenDeny(skill: string | null, failureCode: FailureCode, caps: string[], detail: string): void {
  appendLog({
    actor: "warden",
    event: "denied",
    skill,
    decision: "deny",
    failureCode,
    charterHash: getCharterHash(),
    caps,
    voice: DENIED_VOICE,
    detail,
  });
}

/** Builder in-loop deny (SPEC §9 "Code forge"): a `precheck` deny line, no voice — not an outcome. */
export function wardenPrecheckDeny(skill: string, failureCode: FailureCode, caps: string[], detail: string): void {
  appendLog({ actor: "warden", event: "precheck", skill, decision: "deny", failureCode, charterHash: getCharterHash(), caps, detail });
}

export function denyAndWipe(runDir: string, skill: string | null, failureCode: FailureCode, caps: string[], detail: string): void {
  wardenDeny(skill, failureCode, caps, detail);
  wipeStaging(runDir);
}

/** Runner rule step 2: `job.needs` outside the charter allow-list. */
export function deniedNeeds(job: Job): string[] {
  return job.needs.filter((n) => !isAllowedCap(n));
}

export type PreResult =
  | { ok: true; caps: string[]; env: string[]; folderHash: string }
  | { ok: false; failureCode: FailureCode; caps: string[]; detail: string; literals?: string[] };

/**
 * Warden PRE on staging/<runId>/ (SPEC §8). Check order, first failure wins:
 * name → forbidden_construct → protected_path → secret_in_file → caps → host → manifest_mismatch.
 * Writes the `precheck` allow line; on failure the caller writes the denied line via denyAndWipe.
 */
export function wardenPre(runDir: string, opts: { job: Job; name: string; visited: string[] }): PreResult {
  const { job, name } = opts;
  if (!NAME_RE.test(name)) return { ok: false, failureCode: "invalid_skill_name", caps: [], detail: "name" };
  const skillPath = path.join(runDir, "skill.mjs");
  const manifestPath = path.join(runDir, "manifest.json");
  if (!existsSync(skillPath) || !existsSync(manifestPath)) {
    return { ok: false, failureCode: "manifest_mismatch", caps: [], detail: "missing hand files" };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const scan = scanSkill(readFileSync(skillPath, "utf8"));
  if (scan.fail) return { ok: false, failureCode: scan.fail.code, caps: [...scan.caps], detail: scan.fail.detail, literals: scan.fail.literals };

  // caps: required = scan ∪ manifest ∪ job.needs; anything outside caps-allow → capability_not_allowed
  const required = new Set<string>([...scan.caps, ...(manifest.capabilities ?? []), ...job.needs]);
  const denied = [...required].filter((c) => !isAllowedCap(c));
  if (denied.length) {
    const triggers: string[] = [];
    if (job.needs.some((c) => !isAllowedCap(c))) triggers.push("job_needs");
    if ((manifest.capabilities ?? []).some((c) => !isAllowedCap(c))) triggers.push("manifest");
    for (const c of scan.caps) {
      if (isAllowedCap(c)) continue;
      const mods = [...scan.triggers];
      if (c === "notify:email" && mods.length) triggers.push(...mods);
      else triggers.push(`scan:${c}`);
    }
    return { ok: false, failureCode: "capability_not_allowed", caps: denied, detail: `triggers: ${[...new Set(triggers)].join(", ")}` };
  }

  // hosts (SPEC §6/§8)
  const hosts = manifest.hosts ?? [];
  const never = getCharter().neverHosts;
  if (hosts.some((h) => never.includes(h))) return { ok: false, failureCode: "host_not_allowed", caps: [...required], detail: "never-host" };
  if ([...scan.urlHosts].some((h) => !hosts.includes(h))) {
    return { ok: false, failureCode: "host_not_allowed", caps: [...required], detail: "url host not in manifest" };
  }
  if (hosts.some((h) => h !== BRAVE_HOST && !opts.visited.includes(h))) {
    return { ok: false, failureCode: "host_not_allowed", caps: [...required], detail: "host not visited" };
  }

  // manifest caps must equal scan caps (not checked for email_send, which fails on caps first)
  const mcaps = new Set(manifest.capabilities ?? []);
  if (manifest.kind !== "email_send" && (mcaps.size !== scan.caps.size || [...mcaps].some((c) => !scan.caps.has(c)))) {
    return { ok: false, failureCode: "manifest_mismatch", caps: [...required], detail: "manifest caps != scan caps" };
  }

  const caps = [...required];
  const env = [...scan.env].filter((e) => e in BROKER_MAP);
  const h1 = folderHash(runDir);
  appendLog({
    actor: "warden",
    event: "precheck",
    skill: name,
    decision: "allow",
    charterHash: getCharterHash(),
    caps,
    detail: `caps ${caps.join(",")} ⊆ charter`,
  });
  return { ok: true, caps, env, folderHash: h1 };
}

/** Warden FINAL: re-hash must equal PRE (SPEC §8). Writes the `final` allow line. */
export function wardenFinal(runDir: string, name: string, preHash: string, caps: string[]): boolean {
  if (folderHash(runDir) !== preHash) return false;
  appendLog({
    actor: "warden",
    event: "final",
    skill: name,
    decision: "allow",
    charterHash: getCharterHash(),
    caps,
    detail: "FINAL = PRE",
  });
  return true;
}

/** Install: move staging → skills/<name>/, write decision.json + the `install` line (voice, forge cost). */
export function installSkill(
  runDir: string,
  skillsRoot: string,
  pre: { caps: string[]; env: string[]; folderHash: string },
  forge: { tokens: number; costUsd: number; ms: number },
): DecisionJson {
  const manifest = JSON.parse(readFileSync(path.join(runDir, "manifest.json"), "utf8")) as Manifest;
  const dest = path.join(skillsRoot, manifest.name);
  mkdirSync(skillsRoot, { recursive: true });
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(runDir, dest, { recursive: true });
  const decision: DecisionJson = {
    skill: manifest.name,
    kind: manifest.kind,
    folderHash: pre.folderHash,
    charterHash: getCharterHash(),
    capabilities: manifest.capabilities,
    hosts: manifest.hosts,
    env: pre.env,
    inputs: manifest.inputs,
    purpose: manifest.purpose,
    forgeTokens: forge.tokens,
    forgeMs: Math.round(forge.ms),
    decidedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dest, "decision.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  appendLog({
    actor: "warden",
    event: "install",
    skill: manifest.name,
    decision: "allow",
    charterHash: getCharterHash(),
    caps: decision.capabilities,
    voice: "voice/install.wav",
    detail: `installed ${manifest.name}`,
    tokens: forge.tokens,
    costUsd: forge.costUsd,
    ms: forge.ms,
  });
  wipeStaging(runDir);
  return decision;
}

/**
 * Reuse check (SPEC §8): folder hash and charterHash must equal decision.json, else the single
 * voiced `denied` line with hash_mismatch.
 */
export function wardenReuse(skillDir: string, name: string): DecisionJson | null {
  let decision: DecisionJson | null = null;
  try {
    decision = JSON.parse(readFileSync(path.join(skillDir, "decision.json"), "utf8")) as DecisionJson;
  } catch {
    decision = null;
  }
  let ok = false;
  try {
    ok = !!decision && folderHash(skillDir) === decision.folderHash && decision.charterHash === getCharterHash();
  } catch {
    ok = false;
  }
  if (!ok || !decision) {
    wardenDeny(name, "hash_mismatch", decision?.capabilities ?? [], "reuse: hash != decision.json");
    return null;
  }
  return decision;
}
