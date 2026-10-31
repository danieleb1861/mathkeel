import { execFile, spawn } from "node:child_process";
import type { Contract, SnapshotContractResult } from "./types.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 500;
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY)/i;

/** A contract is arbitrary code: it inherits no secrets from the caller's environment. */
function contractEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!SECRET_ENV.test(name)) env[name] = value;
  }
  return env;
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group has already gone.
  }
}

/** The contract's message: the last output line that is JSON with a string `msg`. */
export function parseContractMessage(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && "msg" in value && typeof value.msg === "string") {
        return value.msg.slice(0, MAX_MESSAGE_CHARS);
      }
    } catch {
      // Not the message line.
    }
  }
  return null;
}

/** Runs one declared command, without a shell, under its timeout. */
export function runContract(root: string, contract: Contract): Promise<SnapshotContractResult> {
  return new Promise((resolve) => {
    const [command, ...args] = contract.command;
    if (command === undefined) {
      resolve({ id: contract.id, state: "fail", msg: "empty command" });
      return;
    }
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      env: contractEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: SnapshotContractResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      finish({ id: contract.id, state: "fail", msg: `timed out after ${contract.timeout_s} s` });
    }, contract.timeout_s * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES);
    });
    child.on("error", (error) => {
      finish({ id: contract.id, state: "fail", msg: `could not start: ${error.message}` });
    });
    child.on("close", (code) => {
      if (timedOut) return;
      const message = parseContractMessage(stdout);
      if (code === 0) finish({ id: contract.id, state: "pass", msg: message ?? "" });
      else finish({ id: contract.id, state: "fail", msg: message ?? `exit code ${code ?? "none"}` });
    });
  });
}

/** Runs each contract once, in map order. Only `mathkeel check` may call this. */
export async function runContracts(
  root: string,
  contracts: Contract[],
  onResult?: (result: SnapshotContractResult) => void,
): Promise<Map<string, SnapshotContractResult>> {
  const results = new Map<string, SnapshotContractResult>();
  for (const contract of contracts) {
    const result = await runContract(root, contract);
    results.set(contract.id, result);
    onResult?.(result);
  }
  return results;
}
