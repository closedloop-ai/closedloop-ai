import { BranchStatus } from "@repo/api/src/types/branch";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { TurnActor } from "@repo/api/src/types/session-transcript-turn";
import { buildMergedTrace } from "@repo/lib/branches/merged-trace";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail as dDetail,
  makeBranchSession as dSession,
} from "../../__tests__/branch-fixtures";
import {
  activeIdleSpans,
  describeLeadTime,
  isBranchMerged,
  isLeadTimeValueUnavailable,
  LEAD_TIME_MERGED_UNAVAILABLE_MESSAGE,
  LEAD_TIME_PENDING_MESSAGE,
  LeadTimeDisplayStatus,
  leadTimeCardValue,
  leadTimeForChange,
  leadTimeWaterfallSegments,
  locPerDollar,
  locPerDollarBaseline30d,
  medianPrSize,
  type PhaseSegment,
  reconcilePhaseSegments,
} from "../branch-derivations";

const NOT_MERGED_RE = /hasn't merged/i;

describe("locPerDollar / locPerDollarBaseline30d", () => {
  it("returns null on null LOC, null cost, or zero cost (never 0)", () => {
    expect(locPerDollar({ churn: null, totalCostUsd: 10 })).toBeNull();
    expect(locPerDollar({ churn: 100, totalCostUsd: null })).toBeNull();
    expect(locPerDollar({ churn: 100, totalCostUsd: 0 })).toBeNull();
    expect(locPerDollar({ churn: 100, totalCostUsd: 25 })).toBe(4);
  });

  it("aggregates the window then divides; null when no LOC or zero cost", () => {
    expect(
      locPerDollarBaseline30d([
        { churn: 100, totalCostUsd: 10 },
        { churn: 50, totalCostUsd: 15 },
      ])
    ).toBe(6); // 150 / 25
    expect(
      locPerDollarBaseline30d([{ churn: null, totalCostUsd: 10 }])
    ).toBeNull();
    expect(locPerDollarBaseline30d([])).toBeNull();
  });
});

describe("leadTimeForChange", () => {
  it("returns the ms delta, or null for missing/negative inputs", () => {
    expect(
      leadTimeForChange({
        firstCommitAt: "2026-06-17T00:00:00.000Z",
        mergedAt: "2026-06-17T01:00:00.000Z",
      })
    ).toBe(3_600_000);
    expect(
      leadTimeForChange({
        firstCommitAt: null,
        mergedAt: "2026-06-17T01:00:00.000Z",
      })
    ).toBeNull();
    expect(
      leadTimeForChange({
        firstCommitAt: "2026-06-17T02:00:00.000Z",
        mergedAt: "2026-06-17T01:00:00.000Z",
      })
    ).toBeNull(); // negative (clock skew)
  });
});

describe("medianPrSize", () => {
  it("includes only merged single-PR branches with both LOC fields", () => {
    const branches = [
      { additions: 10, deletions: 10, status: "merged", multiPrWarning: false }, // 20
      { additions: 30, deletions: 10, status: "merged", multiPrWarning: false }, // 40
      { additions: 90, deletions: 10, status: "merged", multiPrWarning: false }, // 100
      { additions: 5, deletions: 5, status: "open", multiPrWarning: false }, // excluded (open)
      { additions: 5, deletions: 5, status: "merged", multiPrWarning: true }, // excluded (multi-PR)
      {
        additions: null,
        deletions: 5,
        status: "merged",
        multiPrWarning: false,
      }, // excluded (additions null — either missing LOC field excludes the row)
    ];
    expect(medianPrSize(branches)).toBe(40); // median of [20,40,100]
  });

  it("returns null when none qualify", () => {
    expect(
      medianPrSize([
        { additions: 5, deletions: 5, status: "open", multiPrWarning: false },
      ])
    ).toBeNull();
  });
});

describe("activeIdleSpans", () => {
  const base = Date.parse("2026-06-17T00:00:00.000Z");
  const at = (ms: number): string => new Date(base + ms).toISOString();
  const items: MergedTraceItem[] = [
    {
      type: "prompt",
      sessionId: "s1",
      t: at(0),
      tMs: 0,
      cumCostUsd: null,
      actorName: "alice",
      text: "a",
    },
    {
      type: "say",
      sessionId: "s1",
      t: at(60_000),
      tMs: 60_000,
      cumCostUsd: null,
      actorName: "alice",
      text: "b",
    },
    {
      type: "say",
      sessionId: "s1",
      t: at(300_000),
      tMs: 300_000,
      cumCostUsd: null,
      actorName: "alice",
      text: "c",
    },
    { type: "end", sessionId: "s1", text: "done" },
  ];

  it("splits active vs idle at the default 120s threshold", () => {
    const result = activeIdleSpans(items);
    expect(result.activeMs).toBe(60_000); // 0 -> 60s active
    expect(result.idleMs).toBe(240_000); // 60s -> 300s idle (240s gap)
    expect(result.idleSpans).toEqual([
      { startT: at(60_000), endT: at(300_000), gapMs: 240_000 },
    ]);
  });

  it("honors a custom idle threshold", () => {
    const result = activeIdleSpans(items, { idleThresholdMs: 30_000 });
    // Now the 60s gap is also idle.
    expect(result.idleSpans).toHaveLength(2);
    expect(result.activeMs).toBe(0);
    expect(result.idleMs).toBe(300_000);
  });

  /**
   * ISS-8720. The cases above pair point events, whose end IS their start, so
   * they read the same under either derivation. A `tools` run has an extent, and
   * counting it as a pause is what made this walk contradict the trace's own
   * idle row on the same tab.
   */
  const toolRunItems: MergedTraceItem[] = [
    {
      type: "tools",
      sessionId: "s1",
      t: at(0),
      tMs: 0,
      endMs: base + 600_000,
      summary: "12 migration tools",
      hasFail: false,
      failN: 0,
    },
    {
      type: "say",
      sessionId: "s1",
      t: at(960_000),
      tMs: 960_000,
      cumCostUsd: null,
      actorName: "alice",
      text: "after the pause",
    },
  ];

  it("counts a tool run as active and idles only the pause after it", () => {
    const result = activeIdleSpans(toolRunItems);

    // 10m of run, then 6m of real pause — not one 16m gap.
    expect(result.activeMs).toBe(600_000);
    expect(result.idleMs).toBe(360_000);
    expect(result.idleSpans).toEqual([
      { startT: at(600_000), endT: at(960_000), gapMs: 360_000 },
    ]);
  });

  it("agrees with the merged-trace builder on the same pause", () => {
    const [span] = activeIdleSpans(toolRunItems).idleSpans;
    const marker = buildMergedTrace([
      {
        sessionId: "s1",
        startedAt: at(0),
        actorName: "alice",
        harness: "claude",
        turnItems: [
          {
            type: "tools",
            _row: 0,
            t: at(0),
            tMs: base,
            endMs: base + 600_000,
            cum: 0,
            actor: TRACE_ACTOR,
            summary: "12 migration tools",
            items: [],
            hasFail: false,
            failN: 0,
            cats: {},
          },
          {
            type: "say",
            _row: 1,
            t: at(960_000),
            tMs: base + 960_000,
            cum: 0,
            actor: TRACE_ACTOR,
            text: "after the pause",
          },
        ],
      },
    ]).find((item) => item.type === "idle");

    // The whole point of the shared `mergedTraceItemEndMs`: one pause, one
    // duration, one start instant — whichever of the two surfaces states it.
    expect(marker).toMatchObject({ gapMs: span?.gapMs, t: span?.startT });
  });

  /**
   * ISS-8767. `mergedTraceItemEndMs` is also this walk's sweep-line advance, so
   * an impossible `endMs` moved `cursorMs` to the garbage instant: `activeMs`
   * absorbed the whole span and no LATER entry could ever be `> cursorMs`, so
   * every remaining idle span vanished. Two five-minute pauses follow the bad
   * run, and both must survive it.
   */
  const corruptExtentItems = (endMs: number): MergedTraceItem[] => [
    {
      type: "tools",
      sessionId: "s1",
      t: at(0),
      tMs: 0,
      endMs,
      summary: "12 migration tools",
      hasFail: false,
      failN: 0,
    },
    {
      type: "say",
      sessionId: "s1",
      t: at(300_000),
      tMs: 300_000,
      cumCostUsd: null,
      actorName: "alice",
      text: "after the first pause",
    },
    {
      type: "say",
      sessionId: "s1",
      t: at(600_000),
      tMs: 600_000,
      cumCostUsd: null,
      actorName: "alice",
      text: "after the second pause",
    },
  ];

  it.each([
    ["NaN", Number.NaN],
    ["a nanosecond stamp read as ms", Date.now() * 1_000_000],
    ["a fractional millisecond", base + 0.5],
    ["a pre-epoch instant", -1],
    ["a blank stamp folded to 0", Number("")],
  ])("keeps both later idle spans when the run carries %s", (_label, endMs) => {
    const result = activeIdleSpans(corruptExtentItems(endMs));

    expect(result.idleSpans).toEqual([
      { startT: at(0), endT: at(300_000), gapMs: 300_000 },
      { startT: at(300_000), endT: at(600_000), gapMs: 300_000 },
    ]);
    // The refused extent contributes no duration at all — never a plausible
    // one, and never the garbage magnitude that inflated this session's share
    // of the hourly cost bars through `computeBurstSpans`.
    expect(result.activeMs).toBe(0);
    expect(result.idleMs).toBe(600_000);
  });

  it("still counts a healthy extent as active, so the refusal cannot fire on good data", () => {
    const result = activeIdleSpans(corruptExtentItems(base + 240_000));

    // A real four-minute run, then a one-minute pause below the threshold, then
    // the five-minute pause that is genuinely idle.
    expect(result.activeMs).toBe(300_000);
    expect(result.idleSpans).toEqual([
      { startT: at(300_000), endT: at(600_000), gapMs: 300_000 },
    ]);
  });

  const TRACE_ACTOR: TurnActor = {
    name: "alice",
    sessionId: "s1",
    human: "alice",
    color: "",
  };
});

// FEA-2276 removed `partitionBuildVsRework` (the coarse Build/Rework split); its
// replacement, the real per-activity `rollupBranchActivity`, is covered by
// `@repo/lib/branches/activity-rollup.test.ts`. `reconcilePhaseSegments` (retained
// and reused by the new rollup) stays exercised below.
describe("reconcilePhaseSegments (D4)", () => {
  const seg = (key: PhaseSegment["key"], costUsd: number): PhaseSegment => ({
    key,
    label: key,
    costUsd,
    firstRow: null,
  });

  it("null total leaves segments untouched", () => {
    const segments = [seg("build", 5)];
    expect(reconcilePhaseSegments(null, segments)).toBe(segments);
  });

  it("folds a positive remainder into the trailing segment so sum === total", () => {
    const out = reconcilePhaseSegments(10, [seg("build", 4), seg("rework", 1)]);
    expect(out.reduce((s, x) => s + x.costUsd, 0)).toBeCloseTo(10);
    expect(out[1]?.costUsd).toBeCloseTo(6);
  });

  it("scales segments down proportionally when over-attributed", () => {
    const out = reconcilePhaseSegments(5, [seg("build", 6), seg("rework", 4)]);
    expect(out.reduce((s, x) => s + x.costUsd, 0)).toBeCloseTo(5);
    expect(out[0]?.costUsd).toBeCloseTo(3);
    expect(out[1]?.costUsd).toBeCloseTo(2);
  });
});

describe("leadTimeWaterfallSegments (D5)", () => {
  it("anchors on the earliest session start (NOT branch creation) through merge", () => {
    const detail = dDetail({
      status: BranchStatus.Merged,
      lastActivityAt: "2026-06-01T00:00:00.000Z",
      sessions: [
        dSession({ sessionId: "s2", startedAt: "2026-06-10T12:00:00.000Z" }),
        dSession({ sessionId: "s1", startedAt: "2026-06-10T10:00:00.000Z" }),
      ],
      mergedAt: "2026-06-10T13:00:00.000Z",
    });
    const result = leadTimeWaterfallSegments(detail);
    // 10:00 → 13:00 = 3h.
    expect(result.totalMs).toBe(3 * 3_600_000);
    expect(result.mergeUnknown).toBe(false);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.openEnded).toBeUndefined();
  });

  it("open-ended + null total when the branch has not merged", () => {
    const result = leadTimeWaterfallSegments(
      dDetail({ sessions: [dSession()], mergedAt: null })
    );
    expect(result.mergeUnknown).toBe(true);
    expect(result.totalMs).toBeNull();
    expect(result.segments[0]?.openEnded).toBe(true);
  });

  it("totalMs equals the sum of finite segment durations", () => {
    const result = leadTimeWaterfallSegments(
      dDetail({
        status: BranchStatus.Merged,
        sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
        mergedAt: "2026-06-10T11:00:00.000Z",
      })
    );
    const finiteSum = result.segments.reduce(
      (sum, segment) => sum + (segment.durationMs ?? 0),
      0
    );
    expect(result.totalMs).toBe(finiteSum);
  });

  it("flags multiPr from multiPrWarning and empty when no sessions", () => {
    expect(
      leadTimeWaterfallSegments(dDetail({ multiPrWarning: true })).multiPr
    ).toBe(true);
    const empty = leadTimeWaterfallSegments(dDetail({ sessions: [] }));
    expect(empty.segments).toEqual([]);
    expect(empty.totalMs).toBeNull();
  });
});

describe("describeLeadTime (FEA-3974 shared framing)", () => {
  it("merged branch → merged status, no empty message", () => {
    const result = describeLeadTime(
      dDetail({
        status: BranchStatus.Merged,
        sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
        mergedAt: "2026-06-10T11:00:00.000Z",
      })
    );
    expect(result.status).toBe(LeadTimeDisplayStatus.Merged);
    expect(result.emptyMessage).toBeNull();
  });

  it("unmerged branch WITH a session → in-progress framing (matches the card's 'In progress', not the pending copy)", () => {
    // No `firstActivityT`, so the D5 track is empty — the exact VQA state where
    // the old section showed "not enough activity" beside an "In progress" card.
    const result = describeLeadTime(
      dDetail({
        sessions: [dSession()],
        mergedAt: null,
        leadTime: {
          firstActivityT: null,
          lastActivityT: null,
          idleSpans: [],
        },
      })
    );
    expect(result.status).toBe(LeadTimeDisplayStatus.InProgress);
    expect(result.emptyMessage).not.toBe(LEAD_TIME_PENDING_MESSAGE);
    expect(result.emptyMessage).toMatch(NOT_MERGED_RE);
  });

  it("no session anchor → pending status with the shared pending message", () => {
    const result = describeLeadTime(
      dDetail({
        sessions: [],
        mergedAt: null,
        leadTime: {
          firstActivityT: null,
          lastActivityT: null,
          idleSpans: [],
        },
      })
    );
    expect(result.status).toBe(LeadTimeDisplayStatus.Pending);
    expect(result.emptyMessage).toBe(LEAD_TIME_PENDING_MESSAGE);
  });

  it("pending copy is honest about missing activity, not about merge state", () => {
    // The pending body must NOT claim "hasn't merged" — the cause is no captured
    // activity, and the card (not this copy) carries the in-progress framing.
    expect(LEAD_TIME_PENDING_MESSAGE).not.toMatch(NOT_MERGED_RE);
  });
});

describe("leadTimeCardValue (FEA-3974 shared card value)", () => {
  it("merged → the caller's formatted duration", () => {
    expect(leadTimeCardValue(LeadTimeDisplayStatus.Merged, () => "3h")).toBe(
      "3h"
    );
  });

  it("in-progress → 'In progress' (never the merged duration)", () => {
    expect(
      leadTimeCardValue(LeadTimeDisplayStatus.InProgress, () => "3h")
    ).toBe("In progress");
  });

  it("pending → null (no-data), matching the section's empty state", () => {
    // A zero-session branch reads no-data on the card AND "no activity" in the
    // section — never a lone "In progress" beside the empty breakdown (FEA-3974).
    // A nullish value drives MetricCard's muted "No data" glyph (FEA-4236).
    expect(
      leadTimeCardValue(LeadTimeDisplayStatus.Pending, () => "3h")
    ).toBeNull();
  });

  it("merged-unavailable → null no-data value (never 'In progress')", () => {
    // A merged branch with no synced merge time can't show a duration, so the
    // card reads no-data and the breakdown carries the honest reason — it must
    // NOT read "In progress", which would contradict the Merged chip.
    expect(
      leadTimeCardValue(LeadTimeDisplayStatus.MergedUnavailable, () => "3h")
    ).toBeNull();
  });
});

describe("isLeadTimeValueUnavailable (FEA-4236 muted no-data value)", () => {
  it("merged-unavailable and pending have no measurable value", () => {
    expect(
      isLeadTimeValueUnavailable(LeadTimeDisplayStatus.MergedUnavailable)
    ).toBe(true);
    expect(isLeadTimeValueUnavailable(LeadTimeDisplayStatus.Pending)).toBe(
      true
    );
  });

  it("merged and in-progress DO carry a value (not no-data)", () => {
    expect(isLeadTimeValueUnavailable(LeadTimeDisplayStatus.Merged)).toBe(
      false
    );
    expect(isLeadTimeValueUnavailable(LeadTimeDisplayStatus.InProgress)).toBe(
      false
    );
  });
});

describe("isBranchMerged (FEA-4227 merge signal parity with Properties)", () => {
  it("prState=MERGED reads merged even when mergedAt is null", () => {
    expect(
      isBranchMerged({
        prState: GitHubPRState.Merged,
        status: BranchStatus.Open,
      })
    ).toBe(true);
  });

  it("status=merged reads merged (projected status, same as the chip)", () => {
    expect(isBranchMerged({ prState: null, status: BranchStatus.Merged })).toBe(
      true
    );
  });

  it("open PR with no merged status is not merged", () => {
    expect(
      isBranchMerged({ prState: GitHubPRState.Open, status: BranchStatus.Open })
    ).toBe(false);
  });
});

describe("FEA-4227 merged branch never claims 'hasn't merged yet'", () => {
  // The exact VQA repro: PR is MERGED (prState=MERGED) but the merge instant has
  // not synced (mergedAt=null). The lead-time card/breakdown previously said
  // "In progress" / "hasn't merged yet", contradicting the Merged chip.
  const mergedNoTimestamp = dDetail({
    prState: GitHubPRState.Merged,
    status: BranchStatus.Merged,
    sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
    mergedAt: null,
  });

  it("waterfall reports the branch merged (no open-ended in-progress span)", () => {
    const result = leadTimeWaterfallSegments(mergedNoTimestamp);
    expect(result.mergeUnknown).toBe(false);
    expect(result.durationUnavailable).toBe(true);
    expect(result.totalMs).toBeNull();
    expect(result.segments[0]?.openEnded).toBeUndefined();
  });

  it("describeLeadTime resolves to MergedUnavailable with an honest reason", () => {
    const result = describeLeadTime(mergedNoTimestamp);
    expect(result.status).toBe(LeadTimeDisplayStatus.MergedUnavailable);
    expect(result.emptyMessage).toBe(LEAD_TIME_MERGED_UNAVAILABLE_MESSAGE);
    // The copy must NOT contradict the Merged chip.
    expect(result.emptyMessage).not.toMatch(NOT_MERGED_RE);
  });

  it("card value is null no-data, not 'In progress'", () => {
    const status = describeLeadTime(mergedNoTimestamp).status;
    expect(leadTimeCardValue(status, () => "3h")).toBeNull();
  });

  it("a genuinely-in-progress branch (open PR) still reads in-progress", () => {
    const inProgress = dDetail({
      prState: GitHubPRState.Open,
      status: BranchStatus.Open,
      sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
      mergedAt: null,
    });
    const result = describeLeadTime(inProgress);
    expect(result.status).toBe(LeadTimeDisplayStatus.InProgress);
    expect(leadTimeCardValue(result.status, () => "3h")).toBe("In progress");
  });

  it("a merged branch WITH a merge timestamp still shows the measured duration", () => {
    const merged = dDetail({
      prState: GitHubPRState.Merged,
      status: BranchStatus.Merged,
      sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
      mergedAt: "2026-06-10T13:00:00.000Z",
    });
    const result = describeLeadTime(merged);
    expect(result.status).toBe(LeadTimeDisplayStatus.Merged);
    expect(leadTimeWaterfallSegments(merged).totalMs).toBe(3 * 3_600_000);
  });

  it("an open branch with a stale local mergedAt (cloud-hydration overlay) never shows a completed lead time", () => {
    // Desktop cloud hydration can replace status/prState back to Open while the
    // local `mergedAt` lingers. The finite-duration branch must gate on the
    // merge SIGNAL, not `mergedAt` presence, so this reads in-progress — not a
    // closed lead time for an open branch (whitlockk review, FEA-4227).
    const staleMergedAt = dDetail({
      prState: GitHubPRState.Open,
      status: BranchStatus.Open,
      sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
      mergedAt: "2026-06-10T13:00:00.000Z",
    });
    const waterfall = leadTimeWaterfallSegments(staleMergedAt);
    expect(waterfall.mergeUnknown).toBe(true);
    expect(waterfall.totalMs).toBeNull();
    expect(waterfall.durationUnavailable).toBe(false);
    expect(waterfall.segments[0]?.openEnded).toBe(true);

    const result = describeLeadTime(staleMergedAt);
    expect(result.status).toBe(LeadTimeDisplayStatus.InProgress);
    expect(leadTimeCardValue(result.status, () => "3h")).toBe("In progress");
  });

  it("a merged branch with a valid mergedAt but NO session anchor stays pending (no-activity), not 'merge time hasn't synced'", () => {
    // The missing session anchor — not the merge time — is the real gap, so the
    // honest state is the no-activity Pending copy, not the merged-unavailable
    // "merge time hasn't synced" copy (whitlockk review).
    const mergedNoSession = dDetail({
      prState: GitHubPRState.Merged,
      status: BranchStatus.Merged,
      sessions: [],
      mergedAt: "2026-06-10T13:00:00.000Z",
    });
    const waterfall = leadTimeWaterfallSegments(mergedNoSession);
    expect(waterfall.durationUnavailable).toBe(false);
    expect(waterfall.totalMs).toBeNull();

    const result = describeLeadTime(mergedNoSession);
    expect(result.status).toBe(LeadTimeDisplayStatus.Pending);
    expect(result.emptyMessage).toBe(LEAD_TIME_PENDING_MESSAGE);
    expect(result.emptyMessage).not.toBe(LEAD_TIME_MERGED_UNAVAILABLE_MESSAGE);
  });
});
