import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getShellPath,
  resolveBinaryFromLoginShell,
} from "../../server/shell-path.js";

const VERSION = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/;
const run = promisify(execFile);

/** Conservative verified baselines. Unknown harness versions never get a hook
 * which they might silently interpret as synchronous. */
export function supportsSessionMeshAsyncHooks(
  harness: "claude" | "codex",
  version: string
): boolean {
  const parsed = VERSION.exec(version);
  if (!parsed) {
    return false;
  }
  const [major, minor, patch] = parsed.slice(1).map(Number);
  if (harness === "claude") {
    return major === 2 && (minor > 1 || (minor === 1 && patch >= 267));
  }
  return major === 0 && (minor > 156 || (minor === 156 && patch >= 1));
}

export async function detectSessionMeshHarnessSupport(): Promise<{
  claude: boolean;
  codex: boolean;
}> {
  const shellPath = await getShellPath();
  const supported = async (harness: "claude" | "codex") => {
    try {
      const binary = await resolveBinaryFromLoginShell(harness);
      if (
        binary.source === "fallback" ||
        binary.source === "override_invalid"
      ) {
        return false;
      }
      const result = await run(binary.path, ["--version"], {
        env: { ...process.env, PATH: shellPath },
        timeout: 2000,
        maxBuffer: 16_384,
      });
      return supportsSessionMeshAsyncHooks(harness, result.stdout);
    } catch {
      return false;
    }
  };
  const [claude, codex] = await Promise.all([
    supported("claude"),
    supported("codex"),
  ]);
  return { claude, codex };
}
