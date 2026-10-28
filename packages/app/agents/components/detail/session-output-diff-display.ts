import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { locPerDollarNumeratorLines } from "@repo/api/src/utils/loc-per-dollar";

/**
 * ISS-9964 / ISS-9980 (RULED 2026-09-11): the "Lines changed" figure in the
 * session-detail Properties panel — the lines this session landed in MERGED
 * authored PRs, and the SAME number the LOC/$ ratio beside it divides.
 *
 * It now DELEGATES to `locPerDollarNumeratorLines` (`@repo/api`) rather than
 * re-deriving. This module used to re-implement the largest-wins precedence over
 * three rungs (authored-PR roll-up / branch diff / local working-tree diff) in
 * parallel with that helper — a third copy of a rule ISS-6113 had already
 * consolidated twice — so the row and the ratio agreed only for as long as
 * nobody edited one file. One derivation cannot drift from itself.
 *
 * The rungs themselves are retired, not just re-homed. The branch diff and the
 * working-tree scalars measure work in progress: the scalars are transcript-
 * derived rather than git (FEA-3922/FEA-3923) and fold a delegated sub-agent's
 * churn in (ISS-5402), so on golden session 96fef0b5 they read 5313 against a
 * 345-line shipped diff. Neither belongs in a delivered-code figure.
 *
 * `unavailable` is NOT "zero lines". A session that merged nothing returns
 * `merged-pr` with `linesChanged: 0` — a measured fact. `unavailable` means the
 * merged count could not be resolved at all (a desktop session before its first
 * cloud sync, a version-skewed producer sending only the legacy
 * `authoredPrLinesChanged` key, or ISS-4448's session whose 88 merged PRs have
 * no reachable per-PR LOC rows). Rendering that as `0` would report a
 * measurement nobody took.
 */
export function sessionOutputDiffDisplay(
  session: Pick<
    AgentSessionDetail,
    "mergedAuthoredPrLinesChanged" | "authoredPrLinesChanged"
  >
): { kind: "merged-pr"; linesChanged: number } | { kind: "unavailable" } {
  const linesChanged = locPerDollarNumeratorLines(session);
  if (linesChanged === null) {
    return { kind: "unavailable" };
  }
  return { kind: "merged-pr", linesChanged };
}
