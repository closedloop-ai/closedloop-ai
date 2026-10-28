import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import {
  BRANCH_TIMELINE_GROUPING_OPTIONS,
  DEFAULT_BRANCH_TIMELINE_GROUPING,
} from "../../lib/branch-session-buckets";
import { BranchPrActivityTimeline } from "../branch-pr-activity-timeline";

const POSITION_TITLE = "Branch timeline position";
const GROUP_BY_NAME_RE = /group by/i;

function hourSession(sessionId: string, hour: number, owner: string) {
  const start = Date.UTC(2026, 5, 10, hour);
  return makeBranchSession({
    sessionId,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 3_600_000).toISOString(),
    estimatedCostUsd: 1,
    ownerUserName: owner,
  });
}

const shortDetail = makeBranchDetail({
  sessions: [hourSession("s1", 10, "Cosimo")],
});

const longDetail = makeBranchDetail({
  sessions: [hourSession("s1", 0, "Cosimo"), hourSession("s2", 40, "Cosimo")],
});

describe("BranchPrActivityTimeline loading", () => {
  it("renders only a skeleton while loading", () => {
    const { container } = render(
      <BranchPrActivityTimeline detail={shortDetail} isLoading />
    );
    expect(container.querySelector(".bq-act")).toBeNull();
    expect(container.querySelector(".bq-bar")).toBeNull();
    expect(container.firstElementChild?.className).toContain("h-[140px]");
  });
});

describe("BranchPrActivityTimeline position scrubber", () => {
  it("omits the scrubber when every column fits in one window", () => {
    render(
      <BranchPrActivityTimeline
        detail={shortDetail}
        onPositionChange={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("slider", { name: POSITION_TITLE })
    ).not.toBeInTheDocument();
  });

  it("omits the scrubber for a long branch when no position handler is wired", () => {
    render(<BranchPrActivityTimeline detail={longDetail} />);
    expect(
      screen.queryByRole("slider", { name: POSITION_TITLE })
    ).not.toBeInTheDocument();
  });

  it("positions the scrubber at the window start when no column is given", () => {
    render(
      <BranchPrActivityTimeline
        detail={longDetail}
        onWindowStartChange={vi.fn()}
        windowStart={5}
      />
    );
    const slider = screen.getByRole("slider", { name: POSITION_TITLE });
    expect(slider).toHaveValue("5");
    expect(slider).toHaveAttribute("aria-valuetext", "Column 6 of 41");
  });

  it("rounds and clamps an explicit position column into range", () => {
    const { rerender } = render(
      <BranchPrActivityTimeline
        detail={longDetail}
        onPositionChange={vi.fn()}
        positionColumn={2.6}
      />
    );
    expect(screen.getByRole("slider", { name: POSITION_TITLE })).toHaveValue(
      "3"
    );

    rerender(
      <BranchPrActivityTimeline
        detail={longDetail}
        onPositionChange={vi.fn()}
        positionColumn={999}
      />
    );
    expect(screen.getByRole("slider", { name: POSITION_TITLE })).toHaveValue(
      "40"
    );

    rerender(
      <BranchPrActivityTimeline
        detail={longDetail}
        onPositionChange={vi.fn()}
        positionColumn={-4}
      />
    );
    expect(screen.getByRole("slider", { name: POSITION_TITLE })).toHaveValue(
      "0"
    );

    rerender(
      <BranchPrActivityTimeline
        detail={longDetail}
        onPositionChange={vi.fn()}
        positionColumn={Number.NaN}
      />
    );
    expect(screen.getByRole("slider", { name: POSITION_TITLE })).toHaveValue(
      "0"
    );
  });

  it("prefers onPositionChange over onWindowStartChange", () => {
    const onPositionChange = vi.fn();
    const onWindowStartChange = vi.fn();
    render(
      <BranchPrActivityTimeline
        detail={longDetail}
        onPositionChange={onPositionChange}
        onWindowStartChange={onWindowStartChange}
      />
    );
    fireEvent.change(screen.getByRole("slider", { name: POSITION_TITLE }), {
      target: { value: "7" },
    });
    expect(onPositionChange).toHaveBeenCalledWith(7);
    expect(onWindowStartChange).not.toHaveBeenCalled();
  });
});

describe("BranchPrActivityTimeline grouping control", () => {
  it("shows the default grouping when none is passed", () => {
    render(
      <BranchPrActivityTimeline
        detail={shortDetail}
        grouping={undefined}
        onGroupingChange={vi.fn()}
      />
    );
    const defaultLabel = BRANCH_TIMELINE_GROUPING_OPTIONS.find(
      (option) => option.value === DEFAULT_BRANCH_TIMELINE_GROUPING
    )?.label;
    expect(
      screen.getByRole("combobox", { name: GROUP_BY_NAME_RE })
    ).toHaveTextContent(defaultLabel ?? "");
  });
});

describe("BranchPrActivityTimeline duration format", () => {
  it("uses the branch duration format when metric honesty is enabled", () => {
    const detail = makeBranchDetail({
      sessions: [
        hourSession("s1", 10, "Cosimo"),
        hourSession("s2", 13, "Cosimo"),
      ],
    });
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY],
        })}
      >
        <BranchPrActivityTimeline detail={detail} />
      </FeatureFlagAdapterProvider>
    );
    const stats = container.querySelector(".bq-stats");
    expect(stats).not.toHaveTextContent("240m 0s");
    expect(stats).toHaveTextContent("4h");
  });
});

describe("BranchPrActivityTimeline mixed segments", () => {
  it("reserves a fixed slice for unpriced activity sharing an hour with priced spend", () => {
    const start = "2026-06-10T10:00:00.000Z";
    const end = "2026-06-10T11:00:00.000Z";
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "priced",
          startedAt: start,
          endedAt: end,
          estimatedCostUsd: 4,
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "unpriced",
          startedAt: start,
          endedAt: end,
          estimatedCostUsd: 0,
          ownerUserName: "Dana",
        }),
      ],
    });
    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    const heights = Array.from(
      container.querySelectorAll<HTMLElement>(".bq-bar [data-actor-key]")
    ).map((segment) => segment.style.height);
    expect(heights.sort()).toEqual(["8%", "92%"]);
  });
});
