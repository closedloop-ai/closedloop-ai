/**
 * Resolves the desktop build identity telemetry uses to tell two source builds
 * apart (ISS-9743).
 *
 * `desktopClientVersion` cannot. It carries `apps/desktop/package.json`'s
 * `version`, which is the bare series anchor on every build that is not a
 * release — the release workflow writes the minted `desktop-v*` version in
 * BEFORE the build, so only a release ships a version that names anything. The
 * field therefore splits the fleet into "this release" and "some build from
 * source", and inside the second bucket it is a constant: every checkout at
 * every commit reports the same string.
 *
 * `BUILD_COMMIT_HASH` is the commit that constant is missing. It is already
 * generated into the gitignored `src/shared/build-info.ts` by
 * `scripts/write-build-info.mjs` from `git rev-parse HEAD`, so this reuses the
 * existing build-info seam rather than adding a second one.
 *
 * What counts as a commit is NOT decided here. It is the shared wire vocabulary
 * in `@repo/api/src/types/desktop-build-commit`, which the ingest boundary in
 * `@repo/observability/telemetry/schema` reads too, so this producer cannot
 * tighten or loosen out from under the boundary that has to accept it.
 */

import { normalizeDesktopBuildCommit } from "@repo/api/src/types/desktop-build-commit";

/**
 * The commit the running bundle was built from, or `undefined` when the
 * generated constant does not hold one.
 *
 * `undefined` rather than a placeholder is the contract: the trace key must be
 * OMITTED, so a build that could not resolve a commit stays distinguishable
 * from an older client that reports nothing at all (root AGENTS.md, Cross-Repo
 * Compatibility Requirements).
 */
export function resolveDesktopBuildCommit(
  commitHash: string
): string | undefined {
  return normalizeDesktopBuildCommit(commitHash);
}
