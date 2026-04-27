import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { RUNTIME_PORT, WORKSPACE_DIR } from "./config.js";

export type RuntimeStatus = "stopped" | "starting" | "running" | "crashed" | "restarting";

let proc: ChildProcess | null = null;
let status: RuntimeStatus = "stopped";
let lastError: string | null = null;
let startedAt: Date | null = null;

export function getRuntimeStatus() {
  return { status, pid: proc?.pid ?? null, startedAt, lastError };
}

export async function startRuntime(): Promise<void> {
  if (proc) await stopRuntime();

  status = "starting";
  lastError = null;
  startedAt = new Date();

  proc = spawn("tsx", [path.join(WORKSPACE_DIR, "src/index.ts")], {
    cwd: WORKSPACE_DIR,
    env: { ...process.env, RUNTIME_PORT: String(RUNTIME_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[runtime] ${chunk}`);
    if (status === "starting") status = "running";
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[runtime] ${chunk}`);
    if (status === "starting") status = "running";
  });

  proc.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      status = "stopped";
    } else {
      status = "crashed";
      lastError = `Exited with code ${code}`;
      console.error(`[runtime] crashed — code ${code}`);
    }
    proc = null;
  });

  proc.on("error", (err) => {
    status = "crashed";
    lastError = err.message;
    proc = null;
    console.error(`[runtime] spawn error: ${err.message}`);
  });
}

export async function stopRuntime(): Promise<void> {
  if (!proc) return;
  return new Promise((resolve) => {
    const p = proc!;
    const force = setTimeout(() => p.kill("SIGKILL"), 5_000);
    p.once("exit", () => { clearTimeout(force); resolve(); });
    p.kill("SIGTERM");
  });
}

export async function restartRuntime(): Promise<void> {
  status = "restarting";
  await startRuntime();
}
