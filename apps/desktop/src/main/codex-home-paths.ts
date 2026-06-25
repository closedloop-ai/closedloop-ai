import os from "node:os";
import path from "node:path";

const LEADING_TILDE_PATH_PATTERN = /^~(?=\/)/;

export function getCodexHome(): string {
  // Codex accepts a comma-separated CODEX_HOME in some setups; the first entry
  // is the active root. Fall back to ~/.codex.
  const raw = process.env.CODEX_HOME;
  if (raw?.trim()) {
    const first = raw.split(",")[0].trim();
    if (first) {
      return first.replace(LEADING_TILDE_PATH_PATTERN, os.homedir());
    }
  }
  return path.join(os.homedir(), ".codex");
}

export function getCodexConfigPath(): string {
  return path.join(getCodexHome(), "config.toml");
}

export function getCodexSessionsDir(): string {
  return path.join(getCodexHome(), "sessions");
}

export function getCodexArchivedDir(): string {
  return path.join(getCodexHome(), "archived_sessions");
}
