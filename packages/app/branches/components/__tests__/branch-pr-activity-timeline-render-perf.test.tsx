import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import type { TimelineColumn } from "../../lib/branch-session-buckets";
import { BranchPrActivityTimeline } from "../branch-pr-activity-timeline";
import type * as timelineHelpers from "../branch-pr-activity-timeline-helpers";

const helperSpies = vi.hoisted(() => ({
  formatTimelineBarLabel: vi.fn(),
}));

vi.mock("../branch-pr-activity-timeline-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof timelineHelpers>();
  return {
    ...actual,
    formatTimelineBarLabel: (column: TimelineColumn) => {
      helperSpies.formatTimelineBarLabel(column);
      return actual.formatTimelineBarLabel(column);
    },
  };
});

describe("BranchPrActivityTimeline render derivations", () => {
  beforeEach(() => {
    helperSpies.formatTimelineBarLabel.mockClear();
  });

  it("does not rebuild per-column labels on active-hour-only rerenders", () => {
    const detail = makeBranchDetail({
      attributedCostUsd: 12,
      estimatedCostUsd: 12,
      sessions: [
        makeBranchSession({
          endedAt: "2026-06-10T12:00:00.000Z",
          estimatedCostUsd: 6,
          ownerUserName: "Cosimo",
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
        }),
        makeBranchSession({
          endedAt: "2026-06-10T13:00:00.000Z",
          estimatedCostUsd: 6,
          ownerUserName: "Tamsin",
          sessionId: "s2",
          startedAt: "2026-06-10T11:00:00.000Z",
        }),
      ],
    });
    const onScrubHour = vi.fn();
    const { rerender } = render(
      <BranchPrActivityTimeline
        activeFraction={0.1}
        activeHourStart="2026-06-10T10:00:00.000Z"
        detail={detail}
        onScrubHour={onScrubHour}
      />
    );
    const labelCallsAfterInitialRender =
      helperSpies.formatTimelineBarLabel.mock.calls.length;

    expect(labelCallsAfterInitialRender).toBeGreaterThan(0);

    rerender(
      <BranchPrActivityTimeline
        activeFraction={0.5}
        activeHourStart="2026-06-10T11:00:00.000Z"
        detail={detail}
        onScrubHour={onScrubHour}
      />
    );

    expect(helperSpies.formatTimelineBarLabel).toHaveBeenCalledTimes(
      labelCallsAfterInitialRender
    );
  });
});
