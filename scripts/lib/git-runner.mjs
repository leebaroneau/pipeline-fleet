import { spawnSync } from "node:child_process";

export function redactToken(value) {
  return String(value ?? "").replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}

export function runCommand(cmd, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    const safeArgs = args.map(redactToken).join(" ");
    const err = new Error(`${cmd} ${safeArgs} failed to start: ${result.error.message}`);
    err.cause = result.error;
    err.status = result.status;
    err.stdout = redactToken(result.stdout);
    err.stderr = redactToken(result.stderr);
    throw err;
  }

  if (result.status !== 0) {
    const safeArgs = args.map(redactToken).join(" ");
    const safeOutput = redactToken(result.stderr || result.stdout);
    const err = new Error(`${cmd} ${safeArgs} exited ${result.status}: ${safeOutput}`);
    err.status = result.status;
    err.stdout = redactToken(result.stdout);
    err.stderr = redactToken(result.stderr);
    throw err;
  }

  return result;
}
