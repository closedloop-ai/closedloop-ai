import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import {
  reconcileBranchPublicationLoc,
  sumBranchPublicationLoc,
} from "@repo/lib/branches/branch-publication-loc";
import { describe, expect, it } from "vitest";
import {
  cloudRow,
  orgMergedAdmissionForRows,
} from "@/__tests__/support/branches/branch-canonical-metric-projection.test-helpers";
import { projectCloudCanonicalMetrics } from "./branch-canonical-metric-projection";
import { cloudPublicationLocEvidence } from "./branch-publication-loc-projection";
import {
  type BranchPushLocAtom,
  withBranchPushLocEvidence,
} from "./branch-push-loc-read";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MID_SHA = "c".repeat(40);

/**
 * `createdAt` defaults to the atom's own `occurredAt` unless a case overrides
 * it — the same-instant case is "capture was already running for this push",
 * which is what every fixture here means unless it is testing the gap.
 */
function pushAtom(
  branchArtifactId: string,
  overrides: Partial<BranchPushLocAtom> = {}
): BranchPushLocAtom {
  const occurredAt =
    overrides.occurredAt ?? new Date("2026-08-01T00:00:00.000Z");
  return {
    branchArtifactId,
    sourceEventId: "delivery-1",
    occurredAt,
    createdAt: occurredAt,
    beforeSha: BASE_SHA,
    afterSha: MID_SHA,
    linesAdded: 10,
    linesRemoved: 2,
    ...overrides,
  };
}

/** One branch with no merged-PR evidence, so only the push arm can speak. */
function pushOnlyRow(id: string, firstPushedAt: string) {
  const row = cloudRow(id, firstPushedAt, 1);
  row.pullRequestDetails = [];
  return row;
}

function evidenceFor(
  rows: readonly ReturnType<typeof cloudRow>[],
  atomsByBranchId: ReadonlyMap<string, readonly BranchPushLocAtom[]>,
  truncatedBranchIds: ReadonlySet<string> = new Set()
) {
  return cloudPublicationLocEvidence(
    withBranchPushLocEvidence([...rows], {
      byBranchId: atomsByBranchId,
      unusableByBranchId: new Map(),
      truncatedBranchIds,
    }),
    orgMergedAdmissionForRows(...rows)
  );
}

function totalLocPushedFor(
  rows: readonly ReturnType<typeof cloudRow>[],
  atomsByBranchId: ReadonlyMap<string, readonly BranchPushLocAtom[]>,
  window: { startDate: string; endDate: string },
  now = "2026-08-20T00:00:00.000Z"
) {
  const metrics = projectCloudCanonicalMetrics(
    withBranchPushLocEvidence([...rows], {
      byBranchId: atomsByBranchId,
      unusableByBranchId: new Map(),
      truncatedBranchIds: new Set(),
    }),
    {
      startDate: new Date(window.startDate),
      endDate: new Date(window.endDate),
    },
    new Date(now),
    orgMergedAdmissionForRows(...rows)
  );
  const totalLocPushed = metrics.totalLocPushed;
  if (!totalLocPushed) {
    throw new Error("Expected the bundle to publish a pushed-LOC metric");
  }
  return totalLocPushed.current;
}

describe("ISS-10009 part 2 — windowed per-push LOC", () => {
  // AC3. Two pushes eight days apart: each window must report ITS OWN push, not
  // the branch's whole cumulative diff at the latest push's instant.
  it("attributes each captured push to the window it was pushed in", () => {
    const row = pushOnlyRow("multi-window", "2026-08-01T00:00:00.000Z");
    const atoms = new Map([
      [
        row.id,
        [
          pushAtom(row.id, {
            sourceEventId: "delivery-early",
            occurredAt: new Date("2026-08-02T00:00:00.000Z"),
            beforeSha: BASE_SHA,
            afterSha: MID_SHA,
            linesAdded: 30,
            linesRemoved: 0,
          }),
          pushAtom(row.id, {
            sourceEventId: "delivery-late",
            occurredAt: new Date("2026-08-12T00:00:00.000Z"),
            beforeSha: MID_SHA,
            afterSha: HEAD_SHA,
            linesAdded: 7,
            linesRemoved: 0,
          }),
        ],
      ],
    ]);

    const earlyWindow = totalLocPushedFor(
      [row],
      atoms,
      {
        startDate: "2026-07-31T00:00:00.000Z",
        endDate: "2026-08-07T00:00:00.000Z",
      },
      "2026-08-07T00:00:00.000Z"
    );
    const lateWindow = totalLocPushedFor([row], atoms, {
      startDate: "2026-08-08T00:00:00.000Z",
      endDate: "2026-08-15T00:00:00.000Z",
    });

    expect(earlyWindow.value).toBe(30);
    expect(lateWindow.value).toBe(7);
  });

  // AC3, the negative half: a push whose lines the provider could not measure
  // contributes nothing and discloses, rather than summing a short confident
  // number into its window.
  it("records an unmeasured push as a timed gap, never as zero lines", () => {
    const row = pushOnlyRow("unmeasured", "2026-08-01T00:00:00.000Z");
    const evidence = evidenceFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              sourceEventId: "delivery-null",
              occurredAt: new Date("2026-08-02T00:00:00.000Z"),
              linesAdded: null,
              linesRemoved: null,
            }),
          ],
        ],
      ])
    );

    expect(evidence.contributions).toEqual([]);
    expect(evidence.coverageGaps).toContainEqual({
      sourceEventId: "push-loc:delivery-null",
      occurredAt: "2026-08-02T00:00:00.000Z",
    });
  });

  // The sibling of the case above, for a push the READ could not place on a
  // sha range. It reaches the projection as `unusablePushLocAtoms` and must be
  // disclosed on the same footing — dropping it silently would let this branch
  // read Complete while that push's lines are missing.
  it("discloses a captured push the read could not place on a sha range", () => {
    const row = pushOnlyRow("unusable", "2026-08-01T00:00:00.000Z");
    const evidence = cloudPublicationLocEvidence(
      withBranchPushLocEvidence([row], {
        byBranchId: new Map(),
        unusableByBranchId: new Map([
          [
            row.id,
            [
              {
                branchArtifactId: row.id,
                sourceEventId: "delivery-no-range",
                occurredAt: new Date("2026-08-02T00:00:00.000Z"),
              },
            ],
          ],
        ]),
        truncatedBranchIds: new Set(),
      }),
      orgMergedAdmissionForRows(row)
    );

    expect(evidence.contributions).toEqual([]);
    // The atom's own instant, and the era before it — and NO branch-wide
    // `successful-push` gap: an unusable atom IS a capture, so the "capture
    // holds nothing at all" arm stays silent while the pre-capture arm bounds
    // the era on it exactly as it would on a usable one.
    expect(evidence.coverageGaps).toEqual([
      {
        sourceEventId: "push-loc:delivery-no-range",
        occurredAt: "2026-08-02T00:00:00.000Z",
      },
      {
        sourceEventId: "push-loc-pre-capture:unusable",
        occurredAt: "2026-08-01T00:00:00.000Z",
        affectsUntil: "2026-08-02T00:00:00.000Z",
      },
    ]);
    expect(evidence.coverageComplete).toBe(false);
  });

  // AC5, the arm that is the COMMON case rather than an edge: a branch pushed
  // before capture began has no atoms at all, so nothing closes its uncaptured
  // era. An instant at `firstPushedAt` would disclose only the window holding
  // it and let every other window publish `Complete, 0` for a branch whose lines
  // are entirely unknown — the `0` that means "we don't know".
  it("makes a never-captured branch's shortfall reach every window", () => {
    const row = pushOnlyRow("never-captured", "2026-06-01T00:00:00.000Z");
    const evidence = evidenceFor([row], new Map());

    expect(evidence.coverageGaps).toEqual([
      { sourceEventId: "successful-push:never-captured", occurredAt: null },
    ]);
    // A window nowhere near `firstPushedAt` must still refuse to publish.
    const farWindow = totalLocPushedFor([row], new Map(), {
      startDate: "2026-08-01T00:00:00.000Z",
      endDate: "2026-08-08T00:00:00.000Z",
    });
    expect(farWindow.state).not.toBe(BranchMetricAvailability.Complete);
  });

  // AC4. The merged PR and the push that landed its head used to share
  // `repo:sha` while carrying different lines, which reconciliation reads as a
  // contested change and DELETES. The range identity plus the drop is what
  // keeps the change counted exactly once.
  it("drops merged-PR evidence a captured push already covers", () => {
    const row = cloudRow("merged-covered", "2026-08-01T00:00:00.000Z", 1);
    const evidence = evidenceFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              sourceEventId: "delivery-head",
              occurredAt: new Date("2026-08-01T00:00:00.000Z"),
              beforeSha: BASE_SHA,
              afterSha: HEAD_SHA,
              linesAdded: 10,
              linesRemoved: 2,
            }),
          ],
        ],
      ])
    );

    expect(evidence.contributions).toEqual([
      {
        sourceEventId: "push-loc:delivery-head",
        changeIdentity: `org/repo:${BASE_SHA}..${HEAD_SHA}`,
        branchId: row.id,
        occurredAt: "2026-08-01T00:00:00.000Z",
        additions: 10,
        deletions: 2,
        source: "successful_push",
      },
    ]);
    expect(evidence.coverageGaps).toEqual([]);
  });

  // The falsification for the line above: the change must SURVIVE. Before the
  // drop, the push and the PR reconciled under one identity with different
  // lines, so `reconcileBranchPublicationLoc` deleted the change and the branch
  // published nothing at all.
  it("keeps the covered change countable instead of deleting it", () => {
    const row = cloudRow("merged-survives", "2026-08-01T00:00:00.000Z", 1);
    const metric = totalLocPushedFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              sourceEventId: "delivery-head",
              occurredAt: new Date("2026-08-01T00:00:00.000Z"),
              beforeSha: BASE_SHA,
              afterSha: HEAD_SHA,
              linesAdded: 40,
              linesRemoved: 5,
            }),
          ],
        ],
      ]),
      {
        startDate: "2026-07-28T00:00:00.000Z",
        endDate: "2026-08-04T00:00:00.000Z",
      },
      "2026-08-04T00:00:00.000Z"
    );

    expect(metric).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 45,
    });
  });

  // AC4, the fallback arm of ruling 3: a merged PR the push evidence does NOT
  // name stays, so push capture that misses a branch cannot silently erase it.
  it("keeps merged-PR evidence no captured push covers", () => {
    const row = cloudRow("merged-uncovered", "2026-08-01T00:00:00.000Z", 1);
    const evidence = evidenceFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              sourceEventId: "delivery-other",
              beforeSha: BASE_SHA,
              afterSha: MID_SHA,
            }),
          ],
        ],
      ])
    );

    expect(evidence.contributions).toContainEqual(
      expect.objectContaining({
        sourceEventId: "merged-pr:pr-merged-uncovered",
      })
    );
  });

  // AC4, the arm that decides what "fallback" COSTS. A merged PR no push names
  // proves the capture chain missed a push, and that PR carries the branch's
  // whole diff to its head — which already contains every captured push range.
  // Keeping both lanes sums the same lines twice, so the branch falls back to
  // the PR alone and the dropped pushes are disclosed.
  it("drops push contributions rather than sum them beside an uncovered merge", () => {
    const row = cloudRow("chain-broken", "2026-08-01T00:00:00.000Z", 1);
    const evidence = evidenceFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              sourceEventId: "delivery-mid",
              occurredAt: new Date("2026-08-01T00:00:00.000Z"),
              beforeSha: BASE_SHA,
              afterSha: MID_SHA,
              linesAdded: 30,
              linesRemoved: 0,
            }),
          ],
        ],
      ])
    );

    // The merged PR's 12 lines alone — NOT 42, which is what summing the push
    // delta beside the PR's whole-branch diff would publish.
    expect(evidence.contributions).toEqual([
      expect.objectContaining({ sourceEventId: "merged-pr:pr-chain-broken" }),
    ]);
    expect(evidence.coverageGaps).toEqual([
      {
        sourceEventId: "push-loc-uncovered-merge:chain-broken",
        occurredAt: null,
      },
    ]);
    expect(evidence.coverageComplete).toBe(false);
  });

  it("keeps every merged PR when only some merged heads have captured pushes", () => {
    const row = cloudRow("mixed-pr", "2026-08-01T00:00:00.000Z", 1);
    row.pullRequestDetails = [
      ...row.pullRequestDetails,
      {
        ...row.pullRequestDetails[0],
        id: "pr-mixed-pr-2",
        number: 2,
        headRefOid: MID_SHA,
        additions: 100,
        deletions: 3,
        mergedAt: new Date("2026-08-02T00:00:00.000Z"),
        closedAt: new Date("2026-08-02T00:00:00.000Z"),
      },
    ];
    row._count = { pullRequestDetails: 2 };
    const evidence = evidenceFor(
      [row],
      new Map([
        [row.id, [pushAtom(row.id, { afterSha: HEAD_SHA, linesAdded: 4 })]],
      ])
    );

    // PR1's 12 lines and PR2's disjoint 103 lines survive. Neither PR2 alone
    // (103) nor both PRs plus the captured push (121) is the fallback total.
    expect(evidence.contributions).toEqual([
      {
        sourceEventId: "merged-pr:pr-mixed-pr",
        changeIdentity: `org/repo:${HEAD_SHA}`,
        branchId: row.id,
        occurredAt: "2026-08-01T00:00:00.000Z",
        additions: 10,
        deletions: 2,
        source: "merged_pull_request",
      },
      {
        sourceEventId: "merged-pr:pr-mixed-pr-2",
        changeIdentity: `org/repo:${MID_SHA}`,
        branchId: row.id,
        occurredAt: "2026-08-02T00:00:00.000Z",
        additions: 100,
        deletions: 3,
        source: "merged_pull_request",
      },
    ]);
    const reconciled = reconcileBranchPublicationLoc(evidence.contributions);
    expect(reconciled.conflicted).toBe(false);
    expect(sumBranchPublicationLoc(reconciled.values)).toBe(115);
    expect(evidence.coverageGaps).toEqual([
      { sourceEventId: "push-loc-uncovered-merge:mixed-pr", occurredAt: null },
    ]);
    expect(evidence.coverageComplete).toBe(false);
  });

  // AC4 for the multi-PR branch the ticket names as the motivating case. One
  // push per merged head: BOTH PR rows drop and the total is the sum of the two
  // push ranges — a fixture with one PR cannot tell a per-PR drop from a
  // drop-the-first-one-you-find.
  it("drops every merged PR its own captured push covers", () => {
    const row = cloudRow("multi-pr", "2026-08-01T00:00:00.000Z", 1);
    const secondPullRequest = {
      ...row.pullRequestDetails[0],
      id: "pr-multi-pr-2",
      number: 2,
      headRefOid: MID_SHA,
      additions: 100,
      deletions: 0,
      mergedAt: new Date("2026-08-02T00:00:00.000Z"),
      closedAt: new Date("2026-08-02T00:00:00.000Z"),
    };
    row.pullRequestDetails = [row.pullRequestDetails[0], secondPullRequest];
    row._count = { pullRequestDetails: 2 };
    const evidence = evidenceFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              sourceEventId: "delivery-pr1",
              occurredAt: new Date("2026-08-01T00:00:00.000Z"),
              beforeSha: BASE_SHA,
              afterSha: HEAD_SHA,
              linesAdded: 4,
              linesRemoved: 1,
            }),
            pushAtom(row.id, {
              sourceEventId: "delivery-pr2",
              occurredAt: new Date("2026-08-02T00:00:00.000Z"),
              beforeSha: HEAD_SHA,
              afterSha: MID_SHA,
              linesAdded: 6,
              linesRemoved: 2,
            }),
          ],
        ],
      ])
    );

    expect(evidence.contributions.map((c) => c.sourceEventId)).toEqual([
      "push-loc:delivery-pr1",
      "push-loc:delivery-pr2",
    ]);
    expect(evidence.coverageGaps).toEqual([]);
    expect(evidence.coverageComplete).toBe(true);
  });

  // The sibling of the two above, and the case that decides which way a partial
  // capture errs: an UNMEASURED push still claims its head sha, so the PR row is
  // dropped and the branch reports only the pushes it could measure, starred.
  // Keeping the PR row here would publish 12 whole-diff lines BESIDE the 6 the
  // sibling push measured — a confident total larger than the branch pushed.
  it("lets an unmeasured push claim its head rather than inflate the total", () => {
    const row = cloudRow(
      "merged-unmeasured-head",
      "2026-08-01T00:00:00.000Z",
      1
    );
    const evidence = evidenceFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              sourceEventId: "delivery-measured",
              beforeSha: BASE_SHA,
              afterSha: MID_SHA,
              linesAdded: 6,
              linesRemoved: 0,
            }),
            pushAtom(row.id, {
              sourceEventId: "delivery-unmeasured-head",
              beforeSha: MID_SHA,
              afterSha: HEAD_SHA,
              linesAdded: null,
              linesRemoved: null,
            }),
          ],
        ],
      ])
    );

    expect(
      evidence.contributions.map((contribution) => contribution.sourceEventId)
    ).toEqual(["push-loc:delivery-measured"]);
    expect(evidence.coverageGaps).toContainEqual(
      expect.objectContaining({
        sourceEventId: "push-loc:delivery-unmeasured-head",
      })
    );
  });

  // AC5. A cohort spanning captured and uncaptured branches publishes the lines
  // it CAN place and stars the total, rather than either refusing outright or
  // reporting the short sum as whole.
  it("discloses Partial for a cohort holding a branch capture never saw", () => {
    // The captured branch's first push IS its captured one, so its own
    // pre-capture arm cannot fire: the only shortfall in this cohort is the
    // branch that has no atoms at all, which is what the Partial must be about.
    const captured = pushOnlyRow("captured", "2026-08-02T00:00:00.000Z");
    const uncaptured = pushOnlyRow("uncaptured", "2026-08-02T00:00:00.000Z");
    const atoms = new Map([
      [
        captured.id,
        [
          pushAtom(captured.id, {
            occurredAt: new Date("2026-08-02T00:00:00.000Z"),
            linesAdded: 12,
            linesRemoved: 3,
          }),
        ],
      ],
    ]);
    const window = {
      startDate: "2026-07-31T00:00:00.000Z",
      endDate: "2026-08-07T00:00:00.000Z",
    };

    const mixedCohort = totalLocPushedFor(
      [captured, uncaptured],
      atoms,
      window,
      "2026-08-07T00:00:00.000Z"
    );
    // The sibling that makes the Partial above load-bearing: the SAME captured
    // branch alone publishes the same 15 lines as Complete, so the disclosure
    // can only have come from the branch capture never saw.
    const capturedAlone = totalLocPushedFor(
      [captured],
      atoms,
      window,
      "2026-08-07T00:00:00.000Z"
    );

    expect(mixedCohort).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 15,
      disclosure: BranchMetricDisclosure.PushedLocIncomplete,
    });
    expect(capturedAlone).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 15,
    });
  });

  // AC5, the pre-capture arm. `firstPushedAt` is the branch's own record that it
  // was pushed before anything captured it, and ruling 2 forbids synthesizing
  // those lines — so the gap is stamped there and stars only the windows that
  // actually predate capture.
  it("stamps the pre-capture gap at the branch's first push", () => {
    const row = pushOnlyRow("pre-capture", "2026-06-01T00:00:00.000Z");
    const evidence = evidenceFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              occurredAt: new Date("2026-08-02T00:00:00.000Z"),
            }),
          ],
        ],
      ])
    );

    expect(evidence.coverageGaps).toEqual([
      {
        sourceEventId: "push-loc-pre-capture:pre-capture",
        occurredAt: "2026-06-01T00:00:00.000Z",
        // The shortfall SPANS to the first captured push, so a window inside
        // the era is disclosed too — the case below is what proves it.
        affectsUntil: "2026-08-02T00:00:00.000Z",
      },
    ]);
    expect(evidence.coverageComplete).toBe(false);
  });

  // AC5, the arm a single instant could not reach. A window lying wholly inside
  // `[firstPushedAt, firstCapturedPush)` contains NEITHER bound, so before the
  // gap carried a range it read Complete on a period with no push evidence at
  // all — ruling 2 says every pre-capture window discloses, not just the one
  // holding the branch's first push.
  it("discloses a window lying wholly inside the pre-capture era", () => {
    const row = pushOnlyRow("mid-era", "2026-06-01T00:00:00.000Z");
    const atoms = new Map([
      [
        row.id,
        [
          pushAtom(row.id, {
            occurredAt: new Date("2026-08-02T00:00:00.000Z"),
            linesAdded: 9,
            linesRemoved: 0,
          }),
        ],
      ],
    ]);

    // Entirely between the first push and the first captured one.
    const insideEra = totalLocPushedFor(
      [row],
      atoms,
      {
        startDate: "2026-06-15T00:00:00.000Z",
        endDate: "2026-06-22T00:00:00.000Z",
      },
      "2026-06-22T00:00:00.000Z"
    );
    // The sibling that keeps the assertion above from passing on any fixture: a
    // window starting exactly where the era ends must still read Complete, or
    // the range would just be the never-clearing disclosure a null instant
    // gives. Half-open on both sides, so they abut without overlapping.
    const afterCapture = totalLocPushedFor([row], atoms, {
      startDate: "2026-08-02T00:00:00.000Z",
      endDate: "2026-08-09T00:00:00.000Z",
    });

    expect(insideEra.state).toBe(BranchMetricAvailability.Partial);
    expect(afterCapture).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 9,
    });
  });

  // The sibling that keeps the assertion above from passing on any fixture: a
  // branch whose capture starts AT its first push discloses nothing.
  it("raises no pre-capture gap when capture covers the first push", () => {
    const row = pushOnlyRow("fully-captured", "2026-08-02T00:00:00.000Z");
    const evidence = evidenceFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              occurredAt: new Date("2026-08-02T00:00:00.000Z"),
            }),
          ],
        ],
      ])
    );

    expect(evidence.coverageGaps).toEqual([]);
    expect(evidence.coverageComplete).toBe(true);
  });

  // The gap is decided on `occurredAt`, NOT on the row's server `createdAt`,
  // and this pins the reason. `createdAt` is stamped when the webhook persists,
  // so for a branch whose first push WAS captured it is always strictly later
  // than that push's `firstPushedAt` — deciding on it would fire for every
  // captured branch and star every window forever. This case is that branch:
  // captured at its first push, written afterwards, and it must raise NO gap.
  it("raises no pre-capture gap merely because the row was written after the push", () => {
    const row = pushOnlyRow("write-lag", "2026-08-02T00:00:00.000Z");
    const evidence = evidenceFor(
      [row],
      new Map([
        [
          row.id,
          [
            pushAtom(row.id, {
              occurredAt: new Date("2026-08-02T00:00:00.000Z"),
              // Persisted seconds later, as every real capture is.
              createdAt: new Date("2026-08-02T00:00:07.000Z"),
            }),
          ],
        ],
      ])
    );

    expect(evidence.coverageGaps).toEqual([]);
    expect(evidence.coverageComplete).toBe(true);
  });

  // AC5, the read-bound arm. A truncated read could be hiding a push in ANY
  // window, so the gap is deliberately unplaceable and reaches all of them —
  // and it reaches ONLY the branches whose own read was short. The second row
  // is the sibling that makes the scoping load-bearing: an untruncated branch
  // in the same cohort must not inherit the disclosure.
  it("scopes the unplaceable truncation gap to the branches it read short", () => {
    const short = pushOnlyRow("short-read", "2026-08-01T00:00:00.000Z");
    const whole = pushOnlyRow("whole-read", "2026-08-01T00:00:00.000Z");
    const atom = (id: string) =>
      pushAtom(id, { occurredAt: new Date("2026-08-01T00:00:00.000Z") });
    const evidence = evidenceFor(
      [short, whole],
      new Map([
        [short.id, [atom(short.id)]],
        [whole.id, [atom(whole.id)]],
      ]),
      new Set([short.id])
    );

    expect(evidence.coverageGaps).toEqual([
      { sourceEventId: "push-loc-truncated:short-read", occurredAt: null },
    ]);
    expect(evidence.incompleteBranchIds).toEqual(["short-read"]);
    expect(evidence.completeBranchIds).toEqual(["whole-read"]);
  });

  // Ruling 2's headline: a cohort with no captured push publishes NO pushed-LOC
  // total. The current-head file cache this row still carries used to be read as
  // a push observation and answered with the branch's whole diff.
  it("never synthesizes a total from the publication snapshot", () => {
    const row = pushOnlyRow("no-capture", "2026-08-01T00:00:00.000Z");
    const metric = totalLocPushedFor([row], new Map(), {
      startDate: "2026-07-31T00:00:00.000Z",
      endDate: "2026-08-07T00:00:00.000Z",
    });

    expect(row.branch.fileChangeTotals.additions).toBe(10);
    expect(metric).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });
});
