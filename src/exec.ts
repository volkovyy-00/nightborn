import { spawn } from "node:child_process";
import { buildChildEnv } from "./broker.ts";

export type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

export function runSkill(
  absSkillPath: string,
  skillDir: string,
  input: unknown,
  allowedEnv: string[],
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [absSkillPath], {
      cwd: skillDir,
      env: buildChildEnv(allowedEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(err), code: null, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        stdout,
        stderr,
        code,
        timedOut,
      });
    });

    // MUST close stdin or child hangs until timeout (SPEC §9)
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}
