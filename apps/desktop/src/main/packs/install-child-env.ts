/**
 * @file install-child-env.ts
 * @description The execution CONTEXT a catalog install/uninstall subprocess
 * runs in: the security-hardened env allowlist, the cwd validation that decides
 * where it is allowed to run, and the harness-CLI probe that reads that same
 * env's PATH.
 *
 * Split out of `install-orchestrator.ts` (ISS-5138). Command selection
 * (`install-command-resolver.ts`) and the orchestrator itself both depend on
 * these helpers, so they live below both rather than inside either.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type BinaryName,
  getShellPathSync,
  resolveExecutablesOnPathSync,
} from "../../server/shell-path.js";

/**
 * Heuristic for catalog commands that operate on the current directory and
 * must NOT be run without an explicit, validated project cwd. Only matches
 * unambiguous "writes to cwd" signals:
 *   --directory .   (npx-style)
 *   --directory=.   (gnu-arg-style)
 *    -C .           (make / git -C style)
 */
const PROJECT_RELATIVE_HINTS = ["--directory .", "--directory=.", " -C ."];

/**
 * Catalog harness id -> the CLI binary that proves it is installed on this host.
 *
 * Must cover EVERY harness the catalog can list, or an `auto` install of a pack
 * that only lists the missing ones reports `ENOCLI` on a machine that in fact
 * has the CLI. `closedloop-web-command-pack` lists `cursor` and `opencode`
 * alongside `claude`/`codex` in `catalog-seed.json`, so all four are mapped —
 * the same harness-to-binary pairing `command-pack-factory.ts` already uses for
 * its adapters.
 *
 * NULL-PROTOTYPE (ISS-5248), as hardening rather than a live fix: both callers
 * pass a seed-derived name (`entry.harnesses`, or `withCommand` derived from it),
 * so the externally-supplied gateway `harness` does not reach this map — it goes
 * to `resolveRunCommand` instead. Still, a lookup keyed by `"constructor"` or
 * `"toString"` on an object literal returns an inherited FUNCTION that passes the
 * `if (!bin)` gate below, and the only thing that stopped it being used was
 * `path.join` throwing on a non-string binary into the `catch` — correct by
 * accident. With no prototype an unmapped harness is `undefined` whatever it is
 * named.
 */
const HARNESS_CLI_BINARIES: Record<string, BinaryName> = Object.assign(
  Object.create(null),
  {
    claude: "claude",
    codex: "codex",
    cursor: "cursor",
    opencode: "opencode",
  } satisfies Record<string, BinaryName>
);

/**
 * Minimal env passed to child install processes.
 *
 * Only an allowlist of variables needed for sane CLI execution (PATH for
 * binary lookup, HOME / USER for ~/ expansion, LANG / TERM for proper
 * rendering, SHELL for `sh -c`) is passed through. Callers that already
 * resolved a shell PATH can pass `pathOverride` so command selection and child
 * execution use the same lookup path. A malicious or compromised catalog entry
 * cannot exfiltrate Closedloop tokens, PostHog keys, API keys, or shell
 * credentials.
 */
export function buildAllowedChildEnv(
  parentEnv: Record<string, string | undefined> = process.env,
  cwd: string | null = null,
  pathOverride: string | null = null
): Record<string, string> {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "HOMEBREW_PREFIX",
    "HOMEBREW_CELLAR",
    "HOMEBREW_REPOSITORY",
    "PYTHONUNBUFFERED",
  ];
  const out: Record<string, string> = {};
  const childPath =
    typeof pathOverride === "string" && pathOverride.length > 0
      ? pathOverride
      : parentEnv.PATH;
  for (const key of allowed) {
    const val = key === "PATH" ? childPath : parentEnv[key];
    if (typeof val === "string" && val.length > 0) {
      out[key] = val;
    }
  }
  if (!out.HOME) {
    out.HOME = homedir();
  }
  if (cwd) {
    out.INIT_CWD = cwd;
    out.PWD = cwd;
  }
  return out;
}

export function looksProjectRelative(command: string): boolean {
  if (typeof command !== "string") {
    return false;
  }
  return PROJECT_RELATIVE_HINTS.some((hint) => command.includes(hint));
}

/**
 * Validate and resolve a requested CWD for subprocess spawning.
 * Throws with `.code = "EBADCWD"` on invalid input.
 */
export function resolveSpawnCwd(
  requestedCwd: string | undefined | null
): string | null {
  if (typeof requestedCwd !== "string" || requestedCwd.trim().length === 0) {
    return null;
  }

  const trimmed = requestedCwd.trim();
  if (!path.isAbsolute(trimmed)) {
    throw badCwd("cwd must be an absolute path");
  }

  const abs = path.resolve(trimmed);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch {
    throw badCwd(`cwd does not exist: ${abs}`);
  }
  if (!stat.isDirectory()) {
    throw badCwd(`not a directory: ${abs}`);
  }
  if (abs === "/" || abs === path.parse(abs).root) {
    throw badCwd("refusing to spawn at filesystem root");
  }
  return abs;
}

/**
 * The env every command-selection entry point falls back to when a caller does
 * not supply one: the hardened allowlist over the LOGIN-SHELL PATH, so harness
 * detection and the eventual child process agree on where binaries live.
 */
export function defaultResolvedChildEnv(): Record<string, string> {
  return buildAllowedChildEnv(process.env, null, getShellPathSync());
}

/**
 * Probe whether a harness CLI is installed on PATH, so an `auto` install only
 * targets harnesses the user actually has. Reads `childEnv.PATH` so detection
 * stays consistent with install subprocess lookup. Best-effort and
 * short-timeout — never blocks long.
 *
 * ISS-5027 widened this from the `single_install` path it was written for to
 * EVERY `auto` resolution. An explicitly-requested harness is NOT gated on it:
 * that request is the user's own choice and still runs (and fails visibly) if
 * the CLI is missing.
 */
export function isHarnessInstalled(
  harness: string,
  childEnv: Record<string, string | undefined> = defaultResolvedChildEnv()
): boolean {
  const bin = HARNESS_CLI_BINARIES[harness];
  if (!bin) {
    return false;
  }
  try {
    return resolveExecutablesOnPathSync(bin, childEnv.PATH ?? "").length > 0;
  } catch {
    return false;
  }
}

/** The `EBADCWD`-coded error every `resolveSpawnCwd` rejection throws. */
function badCwd(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = "EBADCWD";
  return err;
}
