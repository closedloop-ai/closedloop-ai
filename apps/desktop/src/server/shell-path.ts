import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BinaryResolveSource } from "../shared/cli-binary-tools.js";

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

type ShellPathCacheSlot = {
  cachedShellPath: string | null;
  cachedShellPathPromise: Promise<string> | null;
  // Bumped whenever this slot's value changes under a probe's feet. A probe
  // already in flight answers for the OLD environment, so publishing its result
  // would replace the newer value (ISS-6380). Per slot, not per module: one
  // shared counter would let a reset in one async context supersede an
  // unrelated probe in another, stranding that context uncached.
  generation: number;
};

const globalShellPathCache: ShellPathCacheSlot = {
  cachedShellPath: null,
  cachedShellPathPromise: null,
  generation: 0,
};

type ShellPathTestContext = ShellPathCacheSlot & {
  pathOverride?: string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
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

// Heavy shell profiles (conda / nvm / oh-my-zsh) can take longer than a few
// seconds to source their rc on first launch. A too-tight timeout drops us to
// the minimal fallback PATH and misses the user's real bin dirs. 5s balances
// startup latency against giving a slow rc room to finish. FEA-3742.
const SHELL_PATH_TIMEOUT_MS = 5000;

// Interactive login shell first (sources ~/.zshrc / ~/.bashrc where users add
// nvm/fnm/Homebrew), then a non-interactive login shell as a fallback for rc
// files that misbehave under `-i` (e.g. guarded on `[[ $- == *i* ]]` or that
// block on interactive prompts). FEA-3742.
const SHELL_ARG_VARIANTS: readonly string[][] = [["-ilc"], ["-lc"]];

async function resolveShellPathFromShell(
  env: NodeJS.ProcessEnv
): Promise<string> {
  const shell = configuredShell(env);
  const command = shellPathCommand();
  for (const args of SHELL_ARG_VARIANTS) {
    try {
      const { stdout } = await execFileAsync(shell, [...args, command], {
        timeout: SHELL_PATH_TIMEOUT_MS,
        env: sanitizeSpawnEnv(env),
      });
      const resolved = expandTildes(extractPathFromOutput(stdout));
      if (resolved.trim().length > 0) {
        return resolved;
      }
    } catch {
      // Timed out or the shell errored under this arg variant — try the next.
    }
  }
  return shellPathFallback(env);
}

function resolveShellPathFromShellSync(env: NodeJS.ProcessEnv): string {
  const shell = configuredShell(env);
  const command = shellPathCommand();
  for (const args of SHELL_ARG_VARIANTS) {
    try {
      const stdout = execFileSync(shell, [...args, command], {
        timeout: SHELL_PATH_TIMEOUT_MS,
        env: sanitizeSpawnEnv(env),
        encoding: "utf8",
      });
      const resolved = expandTildes(extractPathFromOutput(stdout));
      if (resolved.trim().length > 0) {
        return resolved;
      }
    } catch {
      // Timed out or the shell errored under this arg variant — try the next.
    }
  }
  return shellPathFallback(env);
}

export async function getShellPath(): Promise<string> {
  const testContext = activeTestContext();
  if (testContext?.pathOverride !== undefined) {
    return testContext.pathOverride;
  }

  const slot = testContext ?? globalShellPathCache;
  if (slot.cachedShellPath !== null) {
    return slot.cachedShellPath;
  }
  if (slot.cachedShellPathPromise !== null) {
    return await slot.cachedShellPathPromise;
  }
  return await resolveIntoShellPathCache(slot, shellPathEnv());
}

/**
 * Resolve the user's login-shell PATH synchronously for sync-only gateway code.
 * Shares the same module-level cache, sentinels, env sanitization, tilde
 * expansion, timeout, and fallback PATH as `getShellPath()`.
 *
 * Limitation: if `getShellPath()` is already resolving and has not populated
 * the cache yet, this sync API cannot await that promise, so that window costs
 * a second login shell. It does NOT cost a wrong answer: publishing here
 * supersedes the in-flight probe, so the older probe cannot overwrite this
 * result on arrival.
 */
export function getShellPathSync(): string {
  const testContext = activeTestContext();
  if (testContext?.pathOverride !== undefined) {
    return testContext.pathOverride;
  }

  const slot = testContext ?? globalShellPathCache;
  if (slot.cachedShellPath !== null) {
    return slot.cachedShellPath;
  }
  return adoptShellPath(slot, resolveShellPathFromShellSync(shellPathEnv()));
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

function clearShellPathSlot(slot: ShellPathCacheSlot): void {
  slot.generation += 1;
  slot.cachedShellPath = null;
  slot.cachedShellPathPromise = null;
}

/** Publish a PATH this slot did not get from an in-flight probe, superseding one. */
function adoptShellPath(slot: ShellPathCacheSlot, shellPath: string): string {
  slot.generation += 1;
  slot.cachedShellPath = shellPath;
  return shellPath;
}

function resetActiveShellPathCache(): void {
  clearShellPathSlot(activeTestContext() ?? globalShellPathCache);
}

/**
 * Reset the cached shell PATH.  Only needed in tests.
 */
export function resetShellPathCache(): void {
  clearShellPathSlot(globalShellPathCache);
  const testContext = activeTestContext();
  if (testContext !== null) {
    clearShellPathSlot(testContext);
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
      generation: 0,
    });
  } else {
    testContext.pathOverride = shellPath;
    adoptShellPath(testContext, shellPath);
  }
  adoptShellPath(globalShellPathCache, shellPath);
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
      generation: 0,
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
  source: BinaryResolveSource;
};

/**
 * True when the resolver actually found the binary on this host — either on the
 * login-shell PATH or at a probed known install location. Kept as a single
 * exported predicate so PATH-vs-known-location "is it really installed?" logic
 * is not re-derived (and re-copied) at each call site. FEA-3742.
 */
export function isResolvedOnHost(source: BinaryResolveSource): boolean {
  return source === "path" || source === "known_location";
}

/**
 * Common absolute install locations for each CLI, consulted as a resolution
 * tier after the login-shell PATH misses. This is the fix for the macOS
 * "installed but not detected" report (FEA-3742): a Finder/Launchpad-launched
 * Electron app inherits a stripped GUI PATH, and the login-shell probe only
 * finds a binary whose dir the user's rc actually exports. The native Claude
 * installer drops `claude` at `~/.claude/local/claude`, which many rc files do
 * not export — so we probe these known paths directly.
 *
 * Canonical source of truth: `health-check.ts` re-exports these for its
 * diagnostics sweep so the two never drift.
 *
 * `~` is expanded to the user's home dir (see `expandTildes`). Order is
 * preference order; the first executable hit wins.
 */
export const KNOWN_BINARY_LOCATIONS: Partial<Record<BinaryName, string[]>> = {
  claude: [
    "~/.claude/local/claude", // Anthropic native installer default
    "/opt/homebrew/bin/claude", // Apple Silicon Homebrew
    "/usr/local/bin/claude", // Intel Homebrew / pre-Apple-Silicon
    "~/.bun/bin/claude",
    "~/.volta/bin/claude",
    "~/.local/bin/claude",
    "/snap/bin/claude", // Linux snap
  ],
  git: ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"],
  gh: ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "~/.local/bin/gh"],
  codex: [
    "~/.volta/bin/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "~/.bun/bin/codex",
    "~/.local/bin/codex",
  ],
  python3: [
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "~/.local/bin/python3",
  ],
};

// Test-only override so a resolver test can pin the known-location set without
// depending on binaries that happen to be installed on the host. Production
// never sets this.
let knownLocationsOverrideForTest: Partial<
  Record<BinaryName, string[]>
> | null = null;

/**
 * @internal Test-only. Override `KNOWN_BINARY_LOCATIONS` per-binary so a test
 * can exercise the known-location tier against a fake path (or assert the tier
 * is skipped with `[]`) without the host's real installs leaking in. Pass
 * `null` to restore defaults.
 */
export function _setKnownBinaryLocationsForResolverTest(
  override: Partial<Record<BinaryName, string[]>> | null
): void {
  knownLocationsOverrideForTest = override;
}

function knownLocationsFor(logicalName: BinaryName): string[] {
  const source = knownLocationsOverrideForTest ?? KNOWN_BINARY_LOCATIONS;
  return source[logicalName] ?? [];
}

/**
 * Probe the known install locations for `logicalName` and return the first
 * path that exists and is executable (`X_OK`), or null. Tildes are expanded
 * to the user's home dir.
 */
async function resolveFromKnownLocations(
  logicalName: BinaryName
): Promise<string | null> {
  for (const loc of knownLocationsFor(logicalName)) {
    const candidate = expandTildes(loc);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // does not exist or not executable — try next
    }
  }
  return null;
}

function resolveFromKnownLocationsSync(logicalName: BinaryName): string | null {
  for (const loc of knownLocationsFor(logicalName)) {
    const candidate = expandTildes(loc);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // does not exist or not executable — try next
    }
  }
  return null;
}

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

  // The login-shell PATH missed (GUI-PATH stripping, a heavy rc that timed out,
  // or an install dir the rc never exported). Before giving up, probe the
  // common absolute install locations so an installed-but-not-on-PATH binary
  // — most importantly the native installer's `~/.claude/local/claude` — is
  // still detected. FEA-3742.
  const knownHit = await resolveFromKnownLocations(logicalName);
  if (knownHit !== null) {
    return { path: knownHit, source: "known_location" };
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

  // Mirror the async resolver: probe known install locations before falling
  // back to the bare name. FEA-3742.
  const knownHit = resolveFromKnownLocationsSync(logicalName);
  if (knownHit !== null) {
    return { path: knownHit, source: "known_location" };
  }

  return { path: logicalName, source: "fallback" };
}

/**
 * Spawn one login-shell probe and publish its answer into `slot`, unless the
 * cache generation moved while the probe was in flight.
 *
 * A superseded probe still returns a usable PATH to its own caller; it just
 * must not become the cached answer.
 */
async function resolveIntoShellPathCache(
  slot: ShellPathCacheSlot,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const generation = slot.generation;
  // Publish this wrapper, not the bare probe, so a second caller arriving
  // mid-probe shares this one spawn instead of starting its own.
  const publishing = (async (): Promise<string> => {
    const resolved = await resolveShellPathFromShell(env);
    if (slot.generation !== generation) {
      // Answer this probe's own callers with this probe's own result. Handing
      // back whatever the slot now holds would feed a newer environment's PATH
      // — a later test's fake-bin dir, another async context's pin — into work
      // that started under the old one, and that PATH goes on to select
      // binaries and build child-process envs (ISS-6380).
      return resolved;
    }
    slot.cachedShellPath = resolved;
    return resolved;
  })();
  slot.cachedShellPathPromise = publishing;
  try {
    return await publishing;
  } finally {
    if (slot.cachedShellPathPromise === publishing) {
      slot.cachedShellPathPromise = null;
    }
  }
}
