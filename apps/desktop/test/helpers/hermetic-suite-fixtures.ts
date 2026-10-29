/**
 * Suite-scoped hermetic environment fixtures: git config and binary-path
 * pinning.
 */

import { afterAll, afterEach, beforeEach } from "vitest";
import { HERMETIC_GIT_ENV } from "../../scripts/hermetic-git-env.mjs";
import { configureBinaryPathsResolver } from "../../src/server/operations/binary-path-overrides.js";
import { resolveExecutablesOnPathSync } from "../../src/server/shell-path.js";

/**
 * Pin git's global/system config to /dev/null for the enclosing suite: the
 * routes run `git worktree add` / `git rev-parse` with the process env, and an
 * operator's global `core.hooksPath` would otherwise fire inside the fixture.
 * Also pins the binary-path resolver so `getResolvedGitPath()` answers from the
 * current PATH instead of spawning a login shell, and restores both.
 */
export function pinHermeticGitForSuite(): void {
  const saved = Object.fromEntries(
    Object.keys(HERMETIC_GIT_ENV).map((key) => [key, process.env[key]])
  );
  const gitPath = resolveExecutablesOnPathSync(
    "git",
    process.env.PATH ?? ""
  )[0];

  beforeEach(() => {
    Object.assign(process.env, HERMETIC_GIT_ENV);
    configureBinaryPathsResolver(() => ({ git: gitPath }));
  });

  afterEach(() => {
    configureBinaryPathsResolver(null);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });
}
