import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { WORKSPACE_DEFAULTS_DIR, WORKSPACE_DIR } from "./config.js";

const exec = promisify(execFile);

export async function initWorkspace(): Promise<void> {
  const srcDir = path.join(WORKSPACE_DIR, "src");

  try {
    await fs.access(srcDir);
    console.log("[workspace] Already initialized");
    return;
  } catch {
    // Volume is empty — first boot
  }

  console.log("[workspace] First boot — copying defaults...");
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  await exec("cp", ["-r", `${WORKSPACE_DEFAULTS_DIR}/.`, `${WORKSPACE_DIR}/`]);

  console.log("[workspace] Installing base packages...");
  await exec("npm", ["install"], { cwd: WORKSPACE_DIR, timeout: 180_000 });

  console.log("[workspace] Ready");
}
