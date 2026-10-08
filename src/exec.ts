// Sandboxed skill run (SPEC §9 "Execution (sandbox)"). Flags are frozen: never relax them to make a run pass.
import { spawn } from "node:child_process";
import { repoPath } from "./paths.ts";
import type { ExecResult, SkillStdin } from "./types.ts";

export const SKILL_TIMEOUT_MS = 15_000;
export const OUTPUT_CAP = 1024 * 1024;

/** Absolute path of the guard preloaded into every skill child (`--import`). */
export const FETCH_GUARD_PATH = repoPath("src", "fetch-guard.mjs");

export function runSkill(
  absSkillPath: string,
  skillDir: string,
  stdin: SkillStdin,
  grant: Record<string, string>,
  hosts: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? SKILL_TIMEOUT_MS;
  const env: Record<string, string> = { ...grant, NB_HOSTS: hosts.join(",") };
  if (process.platform === "win32" && process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${skillDir}`,
        `--allow-fs-read=${FETCH_GUARD_PATH}`,
        "--max-old-space-size=128",
        "--import",
        FETCH_GUARD_PATH,
        absSkillPath,
      ],
      { cwd: skillDir, env, stdio: "pipe" },
    );

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // An aborted Builder session (SPEC §9 limits) must not leave a test child running.
    const onAbort = () => {
      timedOut = true;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (sink: Buffer[], which: "out" | "err") => (chunk: Buffer) => {
      if (overflow) return;
      const total = (which === "out" ? (outBytes += chunk.length) : (errBytes += chunk.length));
      if (total > OUTPUT_CAP) {
        overflow = true;
        kill();
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on("data", collect(out, "out"));
    child.stderr.on("data", collect(err, "err"));

    const finish = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const stderr = Buffer.concat(err).toString("utf8") + (spawnError ? `spawn: ${spawnError.message}` : "");
      resolve({
        ok: !spawnError && !timedOut && !overflow && code === 0,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr,
        code,
        timedOut,
        overflow,
        ms: Date.now() - started,
      });
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));

    // A child that exits before reading stdin makes the write fail with EPIPE; that is not our error.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(stdin)); // MUST close stdin (SPEC §9)
  });
}
