import fs from "node:fs";
import path from "node:path";
import { canonicalizePathForPolicy } from "../server/security.js";
import { expandHomePath } from "../shared/path-utils.js";

/**
 * Golden launch mode (FEA-2648): an env-gated boot variant that renders only the
 * frozen golden dataset out of a throwaway repo-local profile. Resolution is a
 * pure function of the environment plus the pre-redirect `userData` path so it
 * stays unit-testable without booting Electron. With `CLOSEDLOOP_GOLDEN_MODE`
 * unset/falsy this returns `null` and every downstream conditional stays dormant.
 */

/** Turns golden mode on; anything not in the enable set (including unset) is off. */
export const GOLDEN_MODE_ENV_VAR = "CLOSEDLOOP_GOLDEN_MODE";
/** Absolute path to the frozen golden corpus root (`packages/golden-sessions`). */
export const GOLDEN_CORPUS_DIR_ENV_VAR = "CLOSEDLOOP_GOLDEN_CORPUS_DIR";
/** Absolute path to the throwaway profile `userData` is redirected to. */
export const GOLDEN_USER_DATA_DIR_ENV_VAR = "CLOSEDLOOP_GOLDEN_USER_DATA_DIR";

const GOLDEN_MODE_ENABLE_VALUES = new Set(["1", "true", "yes"]);

/** Canonicalized absolute paths owned by the single startup-resolved config. */
export type GoldenModeConfig = {
  corpusDir: string;
  userDataDir: string;
};

export type ResolveGoldenModeConfigContext = {
  /** The pre-redirect `app.getPath("userData")` — the real profile to protect. */
  realUserDataDir: string;
};

/** Thrown for any invalid golden configuration; startup treats it as fatal. */
export class GoldenModeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenModeConfigError";
  }
}

/**
 * Resolves the golden-mode config from the environment, or `null` when golden
 * mode is off. When on, validates and returns canonicalized paths; on any
 * validation failure throws {@link GoldenModeConfigError} — golden mode never
 * silently falls back to the real profile.
 *
 * Guards (realpath-canonical, reusing the `security.ts` path policy):
 *   - `corpusDir` must exist and be a directory.
 *   - `userDataDir` is created (`mkdir -p`) if absent, then must NOT equal,
 *     contain, or be contained by `realUserDataDir`, and must not overlap
 *     `corpusDir` in either direction.
 */
export function resolveGoldenModeConfig(
  env: NodeJS.ProcessEnv,
  { realUserDataDir }: ResolveGoldenModeConfigContext
): GoldenModeConfig | null {
  const flag = env[GOLDEN_MODE_ENV_VAR]?.trim().toLowerCase();
  if (!(flag && GOLDEN_MODE_ENABLE_VALUES.has(flag))) {
    return null;
  }

  const corpusDirRaw = env[GOLDEN_CORPUS_DIR_ENV_VAR]?.trim();
  if (!corpusDirRaw) {
    throw new GoldenModeConfigError(
      `${GOLDEN_MODE_ENV_VAR} is enabled but ${GOLDEN_CORPUS_DIR_ENV_VAR} is not set.`
    );
  }
  const userDataDirRaw = env[GOLDEN_USER_DATA_DIR_ENV_VAR]?.trim();
  if (!userDataDirRaw) {
    throw new GoldenModeConfigError(
      `${GOLDEN_MODE_ENV_VAR} is enabled but ${GOLDEN_USER_DATA_DIR_ENV_VAR} is not set.`
    );
  }

  // Absolute paths only: dev-launch runs Electron with cwd=apps/desktop, so a
  // relative value would silently target a launch-directory-dependent dir.
  const corpusExpanded = expandHomePath(corpusDirRaw);
  if (!path.isAbsolute(corpusExpanded)) {
    throw new GoldenModeConfigError(
      `${GOLDEN_CORPUS_DIR_ENV_VAR} must be an absolute path (got: ${corpusDirRaw})`
    );
  }
  const userDataExpanded = expandHomePath(userDataDirRaw);
  if (!path.isAbsolute(userDataExpanded)) {
    throw new GoldenModeConfigError(
      `${GOLDEN_USER_DATA_DIR_ENV_VAR} must be an absolute path (got: ${userDataDirRaw})`
    );
  }

  const corpusDir = canonicalizePathForPolicy(corpusExpanded);
  let corpusStat: fs.Stats;
  try {
    corpusStat = fs.statSync(corpusDir);
  } catch {
    throw new GoldenModeConfigError(
      `${GOLDEN_CORPUS_DIR_ENV_VAR} does not exist: ${corpusDir}`
    );
  }
  if (!corpusStat.isDirectory()) {
    throw new GoldenModeConfigError(
      `${GOLDEN_CORPUS_DIR_ENV_VAR} is not a directory: ${corpusDir}`
    );
  }

  // Validate BEFORE creating anything: a mis-set userDataDir must never leave
  // a new directory inside the real profile or the corpus, even on the fatal
  // path. canonicalizePathForPolicy handles not-yet-existing paths via the
  // nearest-existing-ancestor realpath, so the overlap guards see through
  // symlinked ancestors without the dir existing.
  const userDataDir = canonicalizePathForPolicy(userDataExpanded);
  const realUserData = canonicalizePathForPolicy(realUserDataDir);

  if (pathsOverlap(userDataDir, realUserData)) {
    throw new GoldenModeConfigError(
      `${GOLDEN_USER_DATA_DIR_ENV_VAR} (${userDataDir}) must not equal, contain, or be contained by the real user data directory (${realUserData}).`
    );
  }
  if (pathsOverlap(userDataDir, corpusDir)) {
    throw new GoldenModeConfigError(
      `${GOLDEN_USER_DATA_DIR_ENV_VAR} (${userDataDir}) must not overlap ${GOLDEN_CORPUS_DIR_ENV_VAR} (${corpusDir}).`
    );
  }

  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new GoldenModeConfigError(
      `${GOLDEN_USER_DATA_DIR_ENV_VAR} could not be created (${userDataDir}): ${reason}`
    );
  }

  return { corpusDir, userDataDir };
}

/** True when the two canonical paths are equal or one contains the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || isContainedBy(a, b) || isContainedBy(b, a);
}

/** Prefix-containment discipline mirrored from `isPathAllowed` (security.ts). */
function isContainedBy(child: string, parent: string): boolean {
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(prefix);
}
