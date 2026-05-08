import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".closedloop-ai", "config");

/**
 * Read a value from ~/.closedloop-ai/config (KEY=value format).
 * Returns undefined if the file or key doesn't exist.
 */
export function readConfig(key: string): string | undefined {
  if (!existsSync(CONFIG_PATH)) {
    return undefined;
  }
  try {
    const lines = readFileSync(CONFIG_PATH, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) {
        continue;
      }
      const k = trimmed.slice(0, eqIdx).trim();
      if (k === key) {
        return trimmed.slice(eqIdx + 1).trim();
      }
    }
  } catch {
    // Config unreadable — fall through
  }
  return undefined;
}
