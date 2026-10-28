/**
 * ISS-12207: the timeline header strip restores the agreed design (ISS-8358
 * prototype, `packages/app/branches/components/prototype-preview/components/branch-sessions-timeline.tsx`):
 * a word space between each value and its label, a screen-reader label on the
 * duration, the body face on values, and no "LOC/$" unit after an absent value.
 */
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
} from "@repo/api/src/types/branch-trace";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { BranchPrActivityTimeline } from "../branch-pr-activity-timeline";

const RATIO_WITH_UNIT_RE = /\d LOC\/\$/;

function pricedDetail() {
  return makeBranchDetail({
    additions: 100,
    attributedCostUsd: 25,
    deletions: 0,
    estimatedCostUsd: 25,
    sessions: [
      makeBranchSession({
        sessionId: "s1",
        slug: "SES-1",
        startedAt: "2026-06-10T10:00:00.000Z",
        endedAt: "2026-06-10T11:00:00.000Z",
        estimatedCostUsd: 25,
        ownerUserName: "Cosimo",
      }),
    ],
  });
}

function strip(container: HTMLElement): HTMLElement {
  const stats = container.querySelector<HTMLElement>(".bq-stats");
  if (!stats) {
    throw new Error("timeline header stats did not render");
  }
  return stats;
}

describe("BranchPrActivityTimeline header stats (ISS-12207)", () => {
  it("separates each value from its label and labels the duration for screen readers", () => {
    const { container } = render(
      <BranchPrActivityTimeline
        detail={pricedDetail()}
        traceState={{
          aggregateCompleteness: {
            state: BranchTraceCompletenessState.Complete,
          },
          completeness: { state: BranchTraceCompletenessState.Complete },
          qualifyingSessionCount: 1,
          sessions: [
            {
              identity: {
                artifactId: "s1",
                name: "SES-1",
                navigableRef: "SES-1",
                slug: "SES-1",
              },
              state: BranchTraceSessionHydrationState.Loaded,
            },
          ],
        }}
      />
    );
    const stats = strip(container);

    expect(stats).toHaveTextContent("$25.00 cost");
    expect(stats.textContent).toMatch(RATIO_WITH_UNIT_RE);
    expect(stats.querySelector(".sr-only")).toHaveTextContent("Duration:");
    expect(stats.querySelector(".font-mono")).toBeNull();
  });

  it("drops the LOC/$ unit when the ratio reads Unavailable", () => {
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY],
        })}
      >
        <BranchPrActivityTimeline
          detail={makeBranchDetail({
            additions: 100,
            deletions: 0,
            estimatedCostUsd: null,
            sessions: [pricedDetail().sessions[0]],
          })}
          traceState={null}
        />
      </FeatureFlagAdapterProvider>
    );
    const stats = strip(container);

    expect(stats).toHaveTextContent("Unavailable cost");
    expect(stats).not.toHaveTextContent("LOC/$");
    expect(stats.querySelector(".sr-only")).toHaveTextContent("Duration:");
  });
});
