import { spawnSync } from "node:child_process";

const SECRET_ENV_KEY = /(TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|(^|_)PAT($|_))/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function secretValues(env) {
  return Object.entries(env ?? {})
    .filter(([key, value]) => SECRET_ENV_KEY.test(key) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

export function redactToken(value, env = process.env) {
  let redacted = String(value ?? "").replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
  for (const secret of secretValues(env)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "***");
  }
  return redacted;
}

export function runCommand(cmd, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    const safeArgs = args.map((arg) => redactToken(arg, env)).join(" ");
    const err = new Error(`${cmd} ${safeArgs} failed to start: ${redactToken(result.error.message, env)}`);
    err.cause = result.error;
    err.status = result.status;
    err.stdout = redactToken(result.stdout, env);
    err.stderr = redactToken(result.stderr, env);
    throw err;
  }

  if (result.status !== 0) {
    const safeArgs = args.map((arg) => redactToken(arg, env)).join(" ");
    const safeOutput = redactToken(result.stderr || result.stdout, env);
    const err = new Error(`${cmd} ${safeArgs} exited ${result.status}: ${safeOutput}`);
    err.status = result.status;
    err.stdout = redactToken(result.stdout, env);
    err.stderr = redactToken(result.stderr, env);
    throw err;
  }

  return result;
}
