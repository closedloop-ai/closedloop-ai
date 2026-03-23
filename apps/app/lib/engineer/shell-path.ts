/**
 * Resolve the user's full login-shell PATH.
 *
 * Electron inherits a minimal PATH that typically omits Homebrew, nvm,
 * and other tool directories. This module spawns the user's login shell
 * once to capture the real PATH and caches it for the process lifetime.
 *
 * The cache is warmed eagerly on import so the first spawn call
 * already has the resolved PATH available.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedPath: string | null = null;
let resolvePromise: Promise<string> | null = null;

/**
 * Get the user's full login-shell PATH (async, cached).
 *
 * Spawns the user's login shell once, caches the result.
 * Falls back to process.env.PATH with platform-appropriate dirs appended.
 */
export async function getShellPath(): Promise<string> {
  if (cachedPath) {
    return cachedPath;
  }

  // Deduplicate concurrent calls
  if (!resolvePromise) {
    resolvePromise = resolveShellPath();
  }

  cachedPath = await resolvePromise;
  resolvePromise = null;
  return cachedPath;
}

/**
 * Get the cached shell PATH synchronously.
 * Returns the resolved path if available, otherwise the platform fallback.
 */
export function getShellPathSync(): string {
  if (cachedPath) {
    return cachedPath;
  }
  // Cache not ready yet — try synchronous resolution as one-shot
  try {
    const shell = findShell();
    if (shell) {
      const stdout = execFileSync(shell, ["-ilc", "echo $PATH"], {
        timeout: 3000,
        encoding: "utf-8",
        env: { ...process.env },
      });
      const resolved = extractPathFromOutput(stdout);
      if (resolved) {
        cachedPath = resolved;
        return resolved;
      }
    }
  } catch {
    // Fall through to platform fallback
  }
  return buildFallbackPath();
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Find the first available login shell. */
function findShell(): string | null {
  const os = platform();
  if (os === "win32") {
    return null; // Windows uses %PATH% directly, no login shell needed
  }

  // Prefer $SHELL, then common shells
  const candidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
  ].filter(Boolean) as string[];

  for (const sh of candidates) {
    if (existsSync(sh)) {
      return sh;
    }
  }
  return null;
}

/**
 * Extract the PATH value from shell output.
 * Takes only the last non-empty line to skip shell startup messages
 * (motd, conda init, etc.) that appear before the echo.
 */
function extractPathFromOutput(stdout: string): string | null {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  // Sanity check: a PATH should contain at least one "/" separator
  if (lastLine.includes("/")) {
    return lastLine;
  }
  return null;
}

/** Build a platform-appropriate fallback PATH. */
function buildFallbackPath(): string {
  const os = platform();
  const home = process.env.HOME ?? "";
  const base = process.env.PATH ?? "";

  if (os === "win32") {
    return base;
  }

  const extras: string[] = [];

  if (os === "darwin") {
    extras.push("/opt/homebrew/bin", "/opt/homebrew/sbin");
  }

  extras.push(
    "/usr/local/bin",
    `${home}/.local/bin`,
    `${home}/.nvm/versions/node/current/bin`
  );

  return [base, ...extras.filter((p) => p && !base.includes(p))].join(":");
}

async function resolveShellPath(): Promise<string> {
  const shell = findShell();
  if (!shell) {
    return buildFallbackPath();
  }

  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", "echo $PATH"], {
      timeout: 5000,
      env: { ...process.env },
    });
    const resolved = extractPathFromOutput(stdout);
    if (resolved) {
      return resolved;
    }
  } catch {
    // Shell spawn failed — fall through to fallback
  }

  return buildFallbackPath();
}

// Warm the cache eagerly on import so getShellPathSync() has the
// resolved PATH available before the first spawn call.
getShellPath().catch(() => {});
