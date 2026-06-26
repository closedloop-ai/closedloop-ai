import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Expand leading ~ in each PATH segment to the user's home directory.
 * Shells expand ~ at assignment time, but single-quoted entries like
 * PATH='~/bin':$PATH preserve the literal ~.  child_process.spawn does
 * not perform tilde expansion, so we must do it ourselves.
 */
export function expandTildes(rawPath: string): string {
  const home = os.homedir();
  return rawPath
    .split(":")
    .map((seg) =>
      seg === "~" ? home : seg.startsWith("~/") ? home + seg.slice(1) : seg
    )
    .join(":");
}

/**
 * Resolve the user's login-shell PATH.
 * Electron on macOS inherits a minimal PATH that excludes /opt/homebrew/bin,
 * nvm paths, etc.  Spawning the user's shell with -ilc gives us the real PATH.
 *
 * We wrap the echo output in unique sentinels so shell startup chatter
 * (MOTD, "Restored session:", conda banners, etc.) can be stripped reliably.
 */
const PATH_SENTINEL_START = "__CLPATH_START__";
const PATH_SENTINEL_END = "__CLPATH_END__";

let cachedShellPath: string | null = null;
let cachedShellPathPromise: Promise<string> | null = null;
type ShellPathTestContext = {
  pathOverride?: string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  cachedShellPath: string | null;
  cachedShellPathPromise: Promise<string> | null;
};
// Node's test runner can execute desktop test files concurrently in one process,
// so fake shells and PATH pins must follow the active async test context instead
// of relying only on process.env and the process-wide production cache.
const testShellPathContext =
  new AsyncLocalStorage<ShellPathTestContext | null>();

function activeTestContext(): ShellPathTestContext | null {
  return testShellPathContext.getStore() ?? null;
}

function shellPathEnv(): NodeJS.ProcessEnv {
  return activeTestContext()?.env ?? process.env;
}

function configuredShell(env: NodeJS.ProcessEnv): string {
  return activeTestContext()?.shell ?? env.SHELL ?? "/bin/zsh";
}

function shellPathFallback(env: NodeJS.ProcessEnv): string {
  return expandTildes(`${env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`);
}

function shellPathCommand(): string {
  return `echo ${PATH_SENTINEL_START}\${PATH}${PATH_SENTINEL_END}`;
}

async function resolveShellPathFromShell(
  env: NodeJS.ProcessEnv
): Promise<string> {
  try {
    const shell = configuredShell(env);
    const { stdout } = await execFileAsync(
      shell,
      ["-ilc", shellPathCommand()],
      {
        timeout: 3000,
        env: sanitizeSpawnEnv(env),
      }
    );
    return expandTildes(extractPathFromOutput(stdout));
  } catch {
    return shellPathFallback(env);
  }
}

function resolveShellPathFromShellSync(env: NodeJS.ProcessEnv): string {
  try {
    const shell = configuredShell(env);
    const stdout = execFileSync(shell, ["-ilc", shellPathCommand()], {
      timeout: 3000,
      env: sanitizeSpawnEnv(env),
      encoding: "utf8",
    });
    return expandTildes(extractPathFromOutput(stdout));
  } catch {
    return shellPathFallback(env);
  }
}

export async function getShellPath(): Promise<string> {
  const testContext = activeTestContext();
  if (testContext?.pathOverride !== undefined) {
    return testContext.pathOverride;
  }

  if (testContext !== null) {
    if (testContext.cachedShellPath !== null) {
      return testContext.cachedShellPath;
    }
    if (testContext.cachedShellPathPromise !== null) {
      return testContext.cachedShellPathPromise;
    }

    testContext.cachedShellPathPromise = resolveShellPathFromShell(
      testContext.env ?? process.env
    );
    try {
      testContext.cachedShellPath = await testContext.cachedShellPathPromise;
      return testContext.cachedShellPath;
    } finally {
      testContext.cachedShellPathPromise = null;
    }
  }

  if (cachedShellPath !== null) {
    return cachedShellPath;
  }
  if (cachedShellPathPromise !== null) {
    return cachedShellPathPromise;
  }

  cachedShellPathPromise = resolveShellPathFromShell(process.env);

  try {
    cachedShellPath = await cachedShellPathPromise;
    return cachedShellPath;
  } finally {
    cachedShellPathPromise = null;
  }
}

/**
 * Resolve the user's login-shell PATH synchronously for sync-only gateway code.
 * Shares the same module-level cache, sentinels, env sanitization, tilde
 * expansion, timeout, and fallback PATH as `getShellPath()`.
 *
 * Limitation: if `getShellPath()` is already resolving and has not populated
 * the cache yet, this sync API cannot await that promise. In that in-flight
 * window it may spawn a separate login shell and cache the sync result.
 */
export function getShellPathSync(): string {
  const testContext = activeTestContext();
  if (testContext?.pathOverride !== undefined) {
    return testContext.pathOverride;
  }

  if (testContext !== null) {
    if (testContext.cachedShellPath !== null) {
      return testContext.cachedShellPath;
    }
    testContext.cachedShellPath = resolveShellPathFromShellSync(
      testContext.env ?? process.env
    );
    return testContext.cachedShellPath;
  }

  if (cachedShellPath !== null) {
    return cachedShellPath;
  }

  cachedShellPath = resolveShellPathFromShellSync(process.env);

  return cachedShellPath;
}

/**
 * Strip env vars that break nvm and other tooling when the desktop app is
 * launched via pnpm.  pnpm sets `npm_config_prefix` to the project dir when
 * running scripts; nvm refuses to initialize in its presence and skips adding
 * the default node version to PATH.  Always sanitize before spawning shells
 * or Node-based CLIs (claude, codex, gh, etc.).
 */
export function sanitizeSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.npm_config_prefix;
  delete copy.NPM_CONFIG_PREFIX;
  return copy;
}

/**
 * Extract the PATH value from shell output by finding the sentinel markers.
 * Falls back to trimming the last non-empty line if sentinels are missing.
 */
export function extractPathFromOutput(stdout: string): string {
  const startIdx = stdout.indexOf(PATH_SENTINEL_START);
  const endIdx = stdout.indexOf(PATH_SENTINEL_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return stdout.slice(startIdx + PATH_SENTINEL_START.length, endIdx);
  }
  // Fallback: take the last non-empty line (most likely the PATH value)
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  return lines.at(-1)?.trim() ?? "";
}

/**
 * Build a process env with the resolved shell PATH.
 * Use this for every spawn/exec that invokes CLI tools (claude, gh, codex, etc.)
 * which may be installed outside Electron's minimal inherited PATH.
 */
export async function getShellEnv(
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  const shellPath = await getShellPath();
  const env = shellPathEnv();
  return {
    ...(sanitizeSpawnEnv(env) as Record<string, string>),
    PATH: shellPath,
    ...extra,
  };
}

function resetActiveShellPathCache(): void {
  const testContext = activeTestContext();
  if (testContext !== null) {
    testContext.cachedShellPath = null;
    testContext.cachedShellPathPromise = null;
    return;
  }
  cachedShellPath = null;
  cachedShellPathPromise = null;
}

/**
 * Reset the cached shell PATH.  Only needed in tests.
 */
export function resetShellPathCache(): void {
  cachedShellPath = null;
  cachedShellPathPromise = null;
  const testContext = activeTestContext();
  if (testContext !== null) {
    testContext.cachedShellPath = null;
    testContext.cachedShellPathPromise = null;
  }
  testShellPathContext.enterWith(null);
}

/**
 * Reset only the shell PATH cache for the active test context.
 * Use this inside `withShellPathEnvForTest()` when the fake shell env changes.
 */
export function resetShellPathCacheOnlyForTest(): void {
  resetActiveShellPathCache();
}

/**
 * Lock the resolved shell PATH to the current process.env.PATH.
 * Only needed in tests that set process.env.PATH to a fake-bin directory —
 * call this instead of resetShellPathCache() so the next getShellPath()
 * returns the test's PATH rather than spawning a login shell that may
 * rebuild PATH via macOS path_helper.
 */
export function setShellPathForTest(): void {
  const testContext = activeTestContext();
  const shellPath = testContext?.env?.PATH ?? process.env.PATH ?? "";
  if (testContext === null) {
    testShellPathContext.enterWith({
      pathOverride: shellPath,
      cachedShellPath: shellPath,
      cachedShellPathPromise: Promise.resolve(shellPath),
    });
  } else {
    testContext.pathOverride = shellPath;
    testContext.cachedShellPath = shellPath;
    testContext.cachedShellPathPromise = Promise.resolve(shellPath);
  }
  cachedShellPath = shellPath;
  cachedShellPathPromise = Promise.resolve(shellPath);
}

/**
 * Run a test with an isolated fake process env for login-shell PATH resolution.
 * The env object is caller-owned, so tests can mutate it before resetting the
 * active context cache to exercise cache invalidation.
 */
export function withShellPathEnvForTest<T>(
  env: NodeJS.ProcessEnv,
  fn: () => T
): T {
  return testShellPathContext.run(
    {
      env,
      shell: env.SHELL,
      cachedShellPath: null,
      cachedShellPathPromise: null,
    },
    fn
  );
}

/**
 * Scan every directory in searchPath for an executable named binary.
 * Returns all hits (not just the first), in PATH order, deduplicated.
 */
export async function resolveExecutablesOnPath(
  binary: string,
  searchPath: string
): Promise<string[]> {
  const segments = searchPath
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const segment of segments) {
    const candidate = path.join(segment, binary);
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      await access(candidate, constants.X_OK);
      hits.push(candidate);
    } catch {
      // not found or not executable
    }
  }
  return hits;
}

/**
 * Synchronous executable scan for sync-only gateway paths that already have a
 * resolved PATH string and cannot await `resolveExecutablesOnPath()`.
 */
export function resolveExecutablesOnPathSync(
  binary: string,
  searchPath: string
): string[] {
  const segments = searchPath
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const segment of segments) {
    const candidate = path.join(segment, binary);
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      accessSync(candidate, constants.X_OK);
      hits.push(candidate);
    } catch {
      // not found or not executable
    }
  }
  return hits;
}

export type BinaryName =
  | "claude"
  | "gh"
  | "codex"
  | "cursor"
  | "opencode"
  | "python3"
  | "git"
  | "rtk"
  | "npm"
  | "ccr";

export type BinaryResolveResult = {
  path: string;
  source: "override" | "override_invalid" | "path" | "fallback";
};

/**
 * Resolve a binary path asynchronously using the user's login-shell PATH
 * (via `getShellPath()`, which spawns `$SHELL -ilc`). Picks up entries added
 * by `~/.zshrc` / `~/.bashrc` (nvm, fnm, asdf, Volta, mise, Homebrew on Apple
 * Silicon, etc.). Override semantics: see body.
 */
export async function resolveBinaryFromLoginShell(
  logicalName: BinaryName,
  override?: string
): Promise<BinaryResolveResult> {
  if (override) {
    try {
      await access(override, constants.X_OK);
      return { path: override, source: "override" };
    } catch {
      return { path: override, source: "override_invalid" };
    }
  }

  const shellPath = await getShellPath();
  const matches = await resolveExecutablesOnPath(logicalName, shellPath);
  if (matches.length > 0) {
    return { path: matches[0], source: "path" };
  }

  return { path: logicalName, source: "fallback" };
}

/**
 * Resolve a binary path synchronously using the user's login-shell PATH.
 * Mirrors `resolveBinaryFromLoginShell()` exactly for override handling,
 * executable PATH discovery, and bare-name fallback, without invoking host
 * discovery tools.
 */
export function resolveBinaryFromLoginShellSync(
  logicalName: BinaryName,
  override?: string
): BinaryResolveResult {
  if (override) {
    try {
      accessSync(override, constants.X_OK);
      return { path: override, source: "override" };
    } catch {
      return { path: override, source: "override_invalid" };
    }
  }

  const shellPath = getShellPathSync();
  const matches = resolveExecutablesOnPathSync(logicalName, shellPath);
  if (matches.length > 0) {
    return { path: matches[0], source: "path" };
  }

  return { path: logicalName, source: "fallback" };
}
