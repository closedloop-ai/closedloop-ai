import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  diffUsageSummary,
  EXPECTED_MOVEMENT,
  summarizeDiff,
} from "@/app/agent-sessions/service/usage-summary-differ";
import { SQL_COMPOSED_SUMMARY_FIELDS } from "@/app/agent-sessions/service/usage-summary-sql";

// These guard the SEAM between the composer and the differ, which is the one
// place a mistake is silent: the composer emits an object, the differ trusts a
// separate list to say what that object actually covers, and nothing but these
// tests keeps the two honest.

/**
 * Every field the shadow compares, RESTATED here rather than read from
 * `SQL_COMPOSED_SUMMARY_FIELDS`. The duplication IS the test.
 *
 * ISS-9975: the subset check this replaced named 17 of the set's 27 entries, so
 * eight of the remaining literals survived mutation to `""` with the whole
 * suite green — and the one other case that touches this set
 * (`usage-summary-shadow.test.ts`) builds its fixtures FROM it, so the oracle
 * mutates along with the thing it is checking and they agree either way. Same
 * lesson `EXPECTED_FLOAT_FIELDS` records in the differ suite.
 *
 * Why a dropped entry is silent rather than loud: `diffUsageSummary` does not
 * report an uncovered field as missing, it stops comparing it. `summarizeDiff`
 * gates `clean` on `defects.length === 0 && notCompared.length === 0`, and a
 * field that left the set is in NEITHER list — so the run still reports
 * `clean: true` with one fewer field checked, and the flag cutover is read off
 * that boolean.
 *
 * Sourced from `AgentSessionUsageSummary` (the wire contract this endpoint
 * publishes), never from the set below.
 *
 * The `satisfies` closes the other half. `SQL_COMPOSED_SUMMARY_FIELDS` is a
 * `ReadonlySet<string>`, so a field renamed in `packages/api` leaves both sides
 * comparing `undefined` against `undefined` and scoring a match — the same
 * silent-agreement shape the `byBranch` case below warns about. Held to `keyof`,
 * the rename fails `tsc` here instead of passing quietly.
 */
const EXPECTED_COMPARED_FIELDS = [
  "viewerScope",
  "totalSessions",
  "earliestSessionAt",
  "latestSessionAt",
  "totalInputTokens",
  "totalOutputTokens",
  "totalCacheReadTokens",
  "totalCacheWriteTokens",
  "totalEstimatedCost",
  "subscriptionEstimatedCost",
  "apiEstimatedCost",
  "meteredEstimatedCost",
  "unknownEstimatedCost",
  "mergedPrCount",
  "medianPrSize",
  "mergedLocPerDollar",
  "mergedLocPerDollarBasis",
  "mergedKlocPerDollar",
  "mergedLocPerDollarCoverage",
  "penseroPointsPerDollar",
  "byModel",
  "byUser",
  "byHarness",
  "byRepository",
  "byProject",
  "modelFilterOptions",
  "lastSyncTargets",
  "comparison",
] as const satisfies ReadonlyArray<keyof AgentSessionUsageSummary>;

describe("SQL_COMPOSED_SUMMARY_FIELDS", () => {
  /**
   * The decided removals, taken from the differ's own allowlist rather than
   * restated here. A test that hard-codes the list can drift from the source of
   * truth it is meant to guard — and spelling the retired metric's identifier in
   * new code is itself a `check:source-gates` violation.
   */
  const decidedRemovals = [...EXPECTED_MOVEMENT.entries()]
    .filter(([, reason]) => reason.startsWith("DECIDED"))
    .map(([field]) => field);

  it("records exactly ONE decided removal, with a dated reason", () => {
    // `byModel` (O2, settled 2026-08-31) is the only one, and it was CONFIRMED
    // on 2026-09-08: every other `byModel` in the repo is a different symbol,
    // and it has no render site, no client read and no entry in the published
    // OpenAPI reference.
    //
    // The retired KLOC-unit metric was the second entry and was NEVER a removal
    // (ISS-9769). `check:source-gates` rejects new USES of it, which is not the
    // same as removing it from the WIRE: a pre-ISS-4667 Desktop still reads it,
    // and the operator ruling on 2026-09-08 was to keep emitting it.
    //
    // It is STILL sanctioned movement, though — it just is not a REMOVAL, and
    // this assertion counts removals rather than entries. Ceasing to be a
    // removal is not the same as agreeing with live: the alias is derived from
    // `mergedLocPerDollar`, which is itself sanctioned, so it moves whenever
    // that does. An earlier revision of this comment said the opposite and
    // dropped its EXPECTED_MOVEMENT entry on that reasoning, which would have
    // stopped a shadow run ever reporting clean in exactly the case that entry
    // exists for (three reviewers on #6853).
    //
    // A removal is identified by the `DECIDED` PREFIX on its reason, which is
    // what `decidedRemovals` filters on above — not by anything structural. So
    // an entry whose reason happens to open with that word joins this count
    // silently, and one that genuinely is a removal but words its reason
    // differently is missed. Keep the prefix deliberate.
    //
    // This count is deliberately exact. Adding a removal means confirming it
    // against the wire contract first — the repo is not the whole consumer list.
    expect(decidedRemovals).toEqual(["byModel"]);
  });

  it("covers the decided removals rather than leaving them uncompared", () => {
    // A decided removal is a difference the differ should REPORT and sanction,
    // not one it should refuse to look at.
    for (const field of decidedRemovals) {
      expect(
        SQL_COMPOSED_SUMMARY_FIELDS.has(field),
        `${field} is a decided removal but is not covered`
      ).toBe(true);
    }
  });

  it("reports a dropped field as expected, and can still reach clean", () => {
    const liveSummary = {
      totalSessions: 64,
      ...Object.fromEntries(decidedRemovals.map((field) => [field, 1])),
    } as unknown as AgentSessionUsageSummary;
    // The candidate omits every decided removal, exactly as the composer does.
    const candidate = {
      totalSessions: 64,
    } as Partial<AgentSessionUsageSummary>;
    const covered = new Set(["totalSessions", ...decidedRemovals]);

    const report = diffUsageSummary(liveSummary, candidate, covered);
    expect(report.defects).toEqual([]);
    expect(report.expected.map((d) => d.field).sort()).toEqual(
      [...decidedRemovals].sort()
    );
    // An allowlisted difference does not block a pass — otherwise a decided
    // removal would keep the flag shut forever.
    expect(summarizeDiff(report).clean).toBe(true);
  });

  it("compares exactly the fields this endpoint publishes, and no others", () => {
    expect([...SQL_COMPOSED_SUMMARY_FIELDS].sort()).toEqual(
      [...EXPECTED_COMPARED_FIELDS].sort()
    );
  });

  it("does not claim coverage for fields this endpoint never published", () => {
    // byBranch and byPr belong to other surfaces. Claiming them would make the
    // differ compare undefined against undefined and score it as a match.
    expect(SQL_COMPOSED_SUMMARY_FIELDS.has("byBranch")).toBe(false);
    expect(SQL_COMPOSED_SUMMARY_FIELDS.has("byPr")).toBe(false);
  });
});
