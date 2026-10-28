/**
 * The desktop build-commit wire vocabulary (ISS-9743).
 *
 * Two sides have to agree on it and neither owns the other: `apps/desktop`
 * decides what it will EMIT (`src/main/util/desktop-build-commit.ts`), and the
 * `@repo/observability` desktop telemetry ingest schema decides what it will
 * ACCEPT. `packages/api/src/types` is the nearest module both already depend
 * on, so the pattern lives here once rather than as a producer copy and a
 * boundary copy that can drift apart — the boundary staying loose while the
 * producer tightened is exactly the gap this closes.
 *
 * Exactly 40 lowercase hex characters, because `git rev-parse HEAD` emits
 * nothing else. An abbreviated or uppercase spelling is rejected rather than
 * folded: accepting either would let one commit appear as several distinct
 * identities in a `GROUP BY` over the trace dimension.
 */

export const DESKTOP_BUILD_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * `value` when it is a full lowercase commit sha, `undefined` otherwise.
 *
 * `undefined` rather than a placeholder is the contract at both ends: the trace
 * key is OMITTED, never set to `null`, `"unknown"`, or a guess. That keeps a
 * build which could not resolve a commit distinguishable from an older client
 * that reports nothing at all (root AGENTS.md, Cross-Repo Compatibility
 * Requirements), and keeps an unbounded attacker-chosen string off a metrics
 * dimension.
 *
 * Typed `unknown` deliberately: the ingest boundary receives whatever an
 * authenticated client sent, so a non-string is reachable there even though the
 * producer's own types forbid it.
 */
export function normalizeDesktopBuildCommit(
  value: unknown
): string | undefined {
  return typeof value === "string" && DESKTOP_BUILD_COMMIT_PATTERN.test(value)
    ? value
    : undefined;
}
