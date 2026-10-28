import type {
  BranchPageDetail,
  BranchSelectedPullRequestDetail,
} from "@repo/api/src/types/branch";
import { BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY } from "@repo/api/src/types/branch-detail-metric-honesty-flag";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { compactBranchDetailPayload } from "@repo/lib/branches/branch-detail-payload";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail as detail } from "../../__tests__/branch-fixtures";
import {
  countingSegment,
  countPredicateInvocations,
} from "../../__tests__/branch-scan-instrumentation";
import {
  BRANCH_OUTCOME_EVIDENCE_CAPPED_FOOTNOTE,
  BRANCH_OUTCOME_EVIDENCE_INCOMPLETE_FOOTNOTE,
} from "../../lib/branch-outcome-copy";
import { BranchLeadTimeWaterfall } from "../branch-lead-time-waterfall";

const OPENED = "2026-08-01T10:30:00.000Z";
const TERMINAL = "2026-08-01T12:00:00.000Z";
const PARTIAL_TOTAL_RE = /120m 0s\*/;
const CYCLE_START_MS = Date.parse("2026-08-01T10:00:00.000Z");
const CYCLE_END_MS = Date.parse(TERMINAL);
const LADDER_SEGMENT_COUNT = 400;
const LADDER_STRIDE_MS = (CYCLE_END_MS - CYCLE_START_MS) / LADDER_SEGMENT_COUNT;
const LADDER_ACTIVE_MS = LADDER_STRIDE_MS / 2;
/** The sweep dispatches no scanning predicate at all; N is generous headroom. */
const LADDER_PREDICATE_CEILING = LADDER_SEGMENT_COUNT;
/** Four source-field reads per segment is the sweep; 8N leaves it headroom. */
const LADDER_FIELD_READ_CEILING = LADDER_SEGMENT_COUNT * 8;
const MERGED_END_LABEL = "Merged";

describe("BranchLeadTimeWaterfall", () => {
  it.each([false, true])(
    "preserves rendered phases after payload compaction (honesty flag: %s)",
    (enabled) => {
      const raw = outcomeDetail("merged", {
        segments: [
          {
            ...phaseSegment(
              BranchVisibleLifecyclePhase.Build,
              "10:00",
              "10:30"
            ),
            costEvents: [
              {
                sourceEventId: "event-1",
                occurredAtMs: CYCLE_START_MS,
                costUsd: 1,
              },
            ],
          },
          phaseSegment(BranchVisibleLifecyclePhase.Review, "10:45", "11:15"),
          phaseSegment(BranchVisibleLifecyclePhase.Rework, "11:30", "12:00"),
        ],
      });
      const adapter = createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY] : [],
      });
      const { container, rerender } = render(
        <FeatureFlagAdapterProvider adapter={adapter}>
          <BranchLeadTimeWaterfall detail={raw} />
        </FeatureFlagAdapterProvider>
      );
      const before = container.innerHTML;
      expect(
        screen.getByText(enabled ? "2h · 25% idle" : "120m 0s · 25% idle")
      ).toBeInTheDocument();
      rerender(
        <FeatureFlagAdapterProvider adapter={adapter}>
          <BranchLeadTimeWaterfall detail={compactBranchDetailPayload(raw)} />
        </FeatureFlagAdapterProvider>
      );
      expect(container.innerHTML).toBe(before);
    }
  );

  it("renders the selected merged cycle as Build, Review, Rework, and Idle", () => {
    const { container } = render(
      <BranchLeadTimeWaterfall detail={outcomeDetail("merged")} />
    );

    expect(screen.getByText("Lead time for change")).toBeInTheDocument();
    expect(screen.getByText("First code pushed")).toBeInTheDocument();
    expect(screen.getByText("PR opened")).toBeInTheDocument();
    expect(screen.getByText(MERGED_END_LABEL)).toBeInTheDocument();
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Rework")).toBeInTheDocument();
    expect(screen.getByText("Idle / waiting")).toBeInTheDocument();
    expect(screen.getByText("120m 0s · 25% idle")).toBeInTheDocument();
    expect(container.querySelectorAll(".bq-lead-seg")).toHaveLength(3);
    expect(container.querySelectorAll(".bq-lead-gap")).toHaveLength(2);
  });

  it("renders closed-unmerged selected cycles as Abandonment Duration", () => {
    render(<BranchLeadTimeWaterfall detail={outcomeDetail("closed")} />);

    expect(screen.getByText("Abandonment Duration")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByText(MERGED_END_LABEL)).not.toBeInTheDocument();
  });

  it("moves a near-edge PR-opened label onto its own axis line", () => {
    const { container } = render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", {
          openedAt: "2026-08-01T10:01:00.000Z",
        })}
      />
    );

    expect(container.querySelector(".bq-lead-axis")).toHaveAttribute(
      "data-pr-opened-edge",
      "start"
    );
    expect(screen.getByText("PR opened")).toHaveAttribute("data-edge", "start");
  });

  it("clips segments to the selected cycle and gives overlapping time to phase precedence", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", {
          idleTimeMs: complete(0),
          segments: [
            phaseSegment(BranchVisibleLifecyclePhase.Build, "09:30", "11:00"),
            phaseSegment(BranchVisibleLifecyclePhase.Review, "10:45", "11:30"),
            phaseSegment(BranchVisibleLifecyclePhase.Rework, "11:15", "12:30"),
          ],
        })}
      />
    );

    expect(screen.getAllByText("45m 0s", { selector: "b" })).toHaveLength(2);
    expect(screen.getByText("30m 0s", { selector: "b" })).toBeInTheDocument();
    expect(screen.getByText("0ms", { selector: "b" })).toBeInTheDocument();
  });

  /**
   * ISS-7039: the same bound as the helper suite's, asserted through the
   * production wiring. That suite pins `visibleOutcomeSegments` in isolation,
   * and the memo test below counts `segments` reads — but a memo read is one
   * read whether the sweep behind it is linear or quadratic, so neither covers
   * `BranchLeadTimeWaterfall` still handing a real branch's attribution to a
   * bounded resolver.
   *
   * Both counters run over one render because each catches a rescan the other
   * cannot see, and both were measured against the mutation they claim to kill.
   * The resolver this replaced clipped into a derived array and rescanned THAT
   * with `find`/`some`, which reads each source field only once — invisible to
   * the field counter, 722,601 predicates to the other. A rescan that walked
   * the source segments again with a bare `for` loop is the mirror image: zero
   * predicates, 642,000 field reads. The sweep that ships reads 0 and 1,600
   * (four fields per segment), so React itself dispatches none of these four
   * methods during this render and the predicate floor here is a true zero
   * rather than a noise budget.
   */
  it("resolves a large branch's attribution with bounded work when rendered", () => {
    const tally = { reads: 0 };
    const source = ladderSegments(LADDER_SEGMENT_COUNT).map((segment) =>
      countingSegment(segment, tally)
    );
    let container: HTMLElement | undefined;

    const invocations = countPredicateInvocations(() => {
      container = render(
        <BranchLeadTimeWaterfall
          detail={outcomeDetail("merged", { segments: source })}
        />
      ).container;
    });

    expect(container?.querySelectorAll(".bq-lead-seg")).toHaveLength(
      LADDER_SEGMENT_COUNT
    );
    expect(invocations).toBeLessThanOrEqual(LADDER_PREDICATE_CEILING);
    expect(tally.reads).toBeLessThanOrEqual(LADDER_FIELD_READ_CEILING);
  });

  it("marks a defensible partial outcome and discloses the incomplete evidence", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", {
          leadTimeMs: partial(2 * 60 * 60 * 1000),
          completeness: BranchPhaseAttributionCompleteness.Partial,
        })}
      />
    );

    expect(screen.getByText(PARTIAL_TOTAL_RE)).toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_OUTCOME_EVIDENCE_INCOMPLETE_FOOTNOTE)
    ).toBeInTheDocument();
  });

  /**
   * ISS-7039: the derivation sweeps every attributed phase segment on the
   * branch, so it must not re-run for a render that changed something else on
   * `detail` and left the attribution inputs at the same references — the
   * second render here — and it must still re-run once the attribution itself
   * moves — the third, which holds every other input at its first-render
   * reference so only `phaseAttribution` can be what re-ran it. Counting reads
   * of `phaseAttribution.segments` is what proves both halves: the waterfall
   * renders identically across the second render either way, so re-asserting it
   * would stay green with the memo removed, and only the third render catches a
   * memo that dropped the attribution key, which would freeze the shipped track
   * on the stale sweep.
   */
  it("re-derives the track only when its attribution inputs change", () => {
    let segmentReads = 0;
    const countedAttribution = (
      source: BranchPageDetail
    ): BranchPhaseAttributionResult => {
      const attribution = source.phaseAttribution;
      if (!attribution) {
        throw new Error("fixture must carry a phase attribution");
      }
      return {
        coverage: attribution.coverage,
        rollups: attribution.rollups,
        get segments() {
          segmentReads += 1;
          return attribution.segments;
        },
      };
    };
    const base = outcomeDetail("merged");
    const unchanged = { ...base, phaseAttribution: countedAttribution(base) };

    const { rerender } = render(<BranchLeadTimeWaterfall detail={unchanged} />);
    rerender(<BranchLeadTimeWaterfall detail={{ ...unchanged }} />);

    expect(segmentReads).toBe(1);
    expect(screen.getByText("120m 0s · 25% idle")).toBeInTheDocument();

    rerender(
      <BranchLeadTimeWaterfall
        detail={{
          ...unchanged,
          phaseAttribution: countedAttribution(
            outcomeDetail("merged", {
              segments: [
                phaseSegment(
                  BranchVisibleLifecyclePhase.Build,
                  "10:00",
                  "11:00"
                ),
                phaseSegment(
                  BranchVisibleLifecyclePhase.Review,
                  "11:00",
                  "12:00"
                ),
              ],
            })
          ),
        }}
      />
    );

    expect(segmentReads).toBe(2);
    expect(screen.getByText("120m 0s · 0% idle")).toBeInTheDocument();
  });

  /**
   * ISS-9862: `CoverageCapped` means the read hit its row limit, which is a
   * different fact from unusable evidence. The two cases below pin each
   * sentence against the reason that selects it (capped on the shipped arm,
   * malformed on the honest arm) and assert the OTHER sentence is absent, so a
   * render that always printed one of them fails.
   */
  it("names the read limit when phase coverage is capped", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", {
          completeness: BranchPhaseAttributionCompleteness.Partial,
          reason: BranchPhaseAttributionCompletenessReason.CoverageCapped,
        })}
      />
    );

    expect(
      screen.getByText(BRANCH_OUTCOME_EVIDENCE_CAPPED_FOOTNOTE)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(BRANCH_OUTCOME_EVIDENCE_INCOMPLETE_FOOTNOTE)
    ).not.toBeInTheDocument();
  });

  it("keeps the generic footnote when the top reason is malformed evidence", () => {
    renderHonestWaterfall(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", {
          completeness: BranchPhaseAttributionCompleteness.Partial,
          reason: BranchPhaseAttributionCompletenessReason.MalformedEvidence,
        })}
      />
    );

    expect(
      screen.getByText(BRANCH_OUTCOME_EVIDENCE_INCOMPLETE_FOOTNOTE)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(BRANCH_OUTCOME_EVIDENCE_CAPPED_FOOTNOTE)
    ).not.toBeInTheDocument();
  });

  it("keeps a complete outcome unstarred when only phase attribution is partial", () => {
    renderHonestWaterfall(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("closed", {
          completeness: BranchPhaseAttributionCompleteness.Partial,
        })}
      />
    );

    expect(screen.getByText("2h · 25% idle")).toBeInTheDocument();
    expect(screen.queryByText(PARTIAL_TOTAL_RE)).not.toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_OUTCOME_EVIDENCE_INCOMPLETE_FOOTNOTE)
    ).toBeInTheDocument();
  });

  it("stars only the idle percentage when the partial idle metric reconciles", () => {
    const { container } = render(
      withHonestFlag(
        <BranchLeadTimeWaterfall
          detail={outcomeDetail("merged", {
            idleTimeMs: partial(30 * 60 * 1000),
          })}
        />
      )
    );
    const idleWidths = Array.from(
      container.querySelectorAll<HTMLElement>(".bq-lead-gap")
    ).map((node) => Number.parseFloat(node.style.width));

    expect(screen.getByText("2h · 25% idle*")).toBeInTheDocument();
    expect(
      screen.getAllByText("30m", { selector: "b" }).length
    ).toBeGreaterThan(0);
    expect(idleWidths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(
      25,
      6
    );
    expect(screen.queryByText(PARTIAL_TOTAL_RE)).not.toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_OUTCOME_EVIDENCE_INCOMPLETE_FOOTNOTE)
    ).toBeInTheDocument();
  });

  it("withholds the waterfall when partial idle contradicts attribution", () => {
    const { container } = render(
      withHonestFlag(
        <BranchLeadTimeWaterfall
          detail={outcomeDetail("merged", {
            idleTimeMs: partial(15 * 60 * 1000),
          })}
        />
      )
    );

    expect(screen.getByText("2h · idle unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Idle evidence is unavailable.")
    ).toBeInTheDocument();
    expect(container.querySelector(".bq-lead-track-wrap")).toBeNull();
    expect(container.querySelector(".bq-lead-key")).toBeNull();
  });

  it("withholds the idle percentage when the idle metric is impossible", () => {
    const { container } = render(
      withHonestFlag(
        <BranchLeadTimeWaterfall
          detail={outcomeDetail("merged", { idleTimeMs: complete(-1) })}
        />
      )
    );

    expect(screen.getByText("2h · idle unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Idle evidence is unavailable.")
    ).toBeInTheDocument();
    expect(container.querySelector(".bq-lead-track-wrap")).toBeNull();
    expect(container.querySelector(".bq-lead-key")).toBeNull();
    expect(container.querySelectorAll(".bq-lead-gap")).toHaveLength(0);
    expect(screen.queryByText("25% idle")).not.toBeInTheDocument();
  });

  it("withholds the idle percentage when the idle metric is unavailable", () => {
    const { container } = render(
      withHonestFlag(
        <BranchLeadTimeWaterfall
          detail={outcomeDetail("merged", { idleTimeMs: unavailable() })}
        />
      )
    );

    expect(screen.getByText("2h · idle unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Idle evidence is unavailable.")
    ).toBeInTheDocument();
    expect(container.querySelector(".bq-lead-track-wrap")).toBeNull();
    expect(container.querySelectorAll(".bq-lead-gap")).toHaveLength(0);
    expect(screen.queryByText("25% idle")).not.toBeInTheDocument();
  });

  it("does not clamp impossible outcome durations into a zero-length track", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", { leadTimeMs: complete(-1) })}
      />
    );

    expect(
      screen.getByText(
        "Selected-cycle outcome evidence is unavailable or not applicable."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("First code pushed")).not.toBeInTheDocument();
  });

  it("reports unavailable when the selected-cycle anchor is indefensible", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", { leadTimeMs: unavailable() })}
      />
    );

    expect(
      screen.getByText(
        "Selected-cycle outcome evidence is unavailable or not applicable."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("First code pushed")).not.toBeInTheDocument();
  });
});

function withHonestFlag(children: ReactNode) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

function renderHonestWaterfall(children: ReactNode) {
  return render(withHonestFlag(children));
}

function outcomeDetail(
  outcome: "closed" | "merged",
  overrides: {
    completeness?:
      | typeof BranchPhaseAttributionCompleteness.Complete
      | typeof BranchPhaseAttributionCompleteness.Partial;
    idleTimeMs?: BranchMetricResult<number>;
    leadTimeMs?: BranchMetricResult<number>;
    openedAt?: string;
    reason?: BranchPhaseAttributionCompletenessReason;
    segments?: BranchPhaseAttributionResult["segments"];
  } = {}
) {
  const duration = 2 * 60 * 60 * 1000;
  const lead = outcome === "merged" ? complete(duration) : notApplicable();
  const abandonment =
    outcome === "closed" ? complete(duration) : notApplicable();
  return detail({
    selectedPullRequest: selectedPullRequest(outcome, overrides.openedAt),
    canonicalMetrics: {
      abandonmentTimeMs: abandonment,
      idleTimeMs: overrides.idleTimeMs ?? complete(30 * 60 * 1000),
      leadTimeMs: overrides.leadTimeMs ?? lead,
      locPerDollar: unavailable(),
      phaseCostUsd: {
        [BranchVisibleLifecyclePhase.Build]: unavailable(),
        [BranchVisibleLifecyclePhase.Review]: unavailable(),
        [BranchVisibleLifecyclePhase.Rework]: unavailable(),
      },
      totalCostUsd: unavailable(),
    },
    phaseAttribution: attribution(
      overrides.segments ?? [
        phaseSegment(BranchVisibleLifecyclePhase.Build, "10:00", "10:30"),
        phaseSegment(BranchVisibleLifecyclePhase.Review, "10:45", "11:15"),
        phaseSegment(BranchVisibleLifecyclePhase.Rework, "11:30", "12:00"),
      ],
      overrides.completeness ?? BranchPhaseAttributionCompleteness.Complete,
      overrides.reason
    ),
  });
}

function selectedPullRequest(
  outcome: "closed" | "merged",
  openedAt = OPENED
): BranchSelectedPullRequestDetail {
  return {
    id: "acme/web#42",
    repositoryFullName: "acme/web",
    number: 42,
    title: "Selected PR",
    url: "https://github.com/acme/web/pull/42",
    state: outcome === "merged" ? GitHubPRState.Merged : GitHubPRState.Closed,
    isDraft: false,
    reviewDecision: null,
    openedAt,
    closedAt: outcome === "closed" ? TERMINAL : null,
    mergedAt: outcome === "merged" ? TERMINAL : null,
    body: null,
    headRefOid: null,
    mergeCommitSha: null,
    baseRefName: null,
    authorLogin: null,
    changedFiles: null,
    additions: null,
    deletions: null,
  };
}

function attribution(
  segments: BranchPhaseAttributionResult["segments"],
  completeness:
    | typeof BranchPhaseAttributionCompleteness.Complete
    | typeof BranchPhaseAttributionCompleteness.Partial,
  reason: BranchPhaseAttributionCompletenessReason = BranchPhaseAttributionCompletenessReason.PricingIncomplete
): BranchPhaseAttributionResult {
  const subtotalUsd = segments.reduce(
    (sum, segment) => sum + segment.estimatedCostUsd,
    0
  );
  const coverage =
    completeness === BranchPhaseAttributionCompleteness.Complete
      ? { completeness, subtotalUsd }
      : {
          completeness: BranchPhaseAttributionCompleteness.Partial,
          reason,
          subtotalUsd,
        };
  return {
    segments,
    rollups: Object.values(BranchVisibleLifecyclePhase).map((phase) => ({
      phase,
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      sessionCount: 1,
    })),
    coverage,
  };
}

function phaseSegment(
  phase: BranchVisibleLifecyclePhase,
  start: string,
  end: string
) {
  return {
    sessionId: `${phase}-${start}`,
    sequence: 0,
    phase,
    startMs: Date.parse(`2026-08-01T${start}:00.000Z`),
    endMs: Date.parse(`2026-08-01T${end}:00.000Z`),
    estimatedCostUsd: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    evidenceIds: [],
  };
}

/** `count` short phases separated by idle gaps, filling the selected cycle. */
function ladderSegments(
  count: number
): BranchPhaseAttributionResult["segments"] {
  const phases = Object.values(BranchVisibleLifecyclePhase);
  return Array.from({ length: count }, (_unused, index) => {
    const startMs = CYCLE_START_MS + index * LADDER_STRIDE_MS;
    const phase =
      phases[index % phases.length] ?? BranchVisibleLifecyclePhase.Build;
    return {
      sessionId: `${phase}-${index}`,
      sequence: index,
      phase,
      startMs,
      endMs: startMs + LADDER_ACTIVE_MS,
      estimatedCostUsd: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      evidenceIds: [],
    };
  });
}

function complete(value: number): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Complete, value };
}

function partial(value: number): BranchMetricResult<number> {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    disclosure: BranchMetricDisclosure.DefaultIncomplete,
  };
}

function unavailable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}

function notApplicable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.NotApplicable, value: null };
}
