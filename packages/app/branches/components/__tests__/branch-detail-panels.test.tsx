import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail as detail,
  makeBranchSession as session,
} from "../../__tests__/branch-fixtures";
import { BranchHeadlineCards } from "../branch-headline-cards";
import { BranchLeadTimeWaterfall } from "../branch-lead-time-waterfall";
import { BranchMultiPrNotice } from "../branch-multi-pr-notice";
import { BranchPropertiesPanel } from "../branch-properties-panel";

const OUTCOME_UNAVAILABLE_RE =
  /selected-cycle outcome evidence is unavailable or not applicable/i;
const PROPERTIES_RE = /properties/i;
const LONG_BRANCH_NAME =
  "feature/narrow-responsive-properties-panel-with-a-very-long-branch-name";
const LONG_REPOSITORY_NAME =
  "closedloop-ai/repository-with-a-very-long-name-for-responsive-panels";
const SELECTED_PR_TITLE =
  "Selected pull request title belongs outside Properties";

describe("BranchLeadTimeWaterfall", () => {
  it("does not fabricate an outcome track for an open Branch", () => {
    render(
      <BranchLeadTimeWaterfall detail={detail({ sessions: [session()] })} />
    );
    expect(screen.getByText(OUTCOME_UNAVAILABLE_RE)).toBeInTheDocument();
    expect(screen.getByText("Lead time for change")).toBeInTheDocument();
  });

  it("does not render a measured track when a merged Branch lacks merge time", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={detail({
          mergedAt: null,
          prState: GitHubPRState.Merged,
          sessions: [session()],
          status: BranchStatus.Merged,
        })}
      />
    );
    expect(screen.getByText(OUTCOME_UNAVAILABLE_RE)).toBeInTheDocument();
    expect(screen.queryByText("First code pushed")).not.toBeInTheDocument();
  });
});

describe("BranchHeadlineCards", () => {
  it("renders exactly the three approved metric labels", () => {
    render(<BranchHeadlineCards detail={detail()} />);

    expect(screen.getByText("LOC per $")).toBeInTheDocument();
    expect(screen.getByText("Lead time for change")).toBeInTheDocument();
    expect(screen.getByText("Abandonment Duration")).toBeInTheDocument();
    expect(screen.queryByText("LOC / $")).not.toBeInTheDocument();
  });

  it("renders canonical complete, not-applicable, and no-data states", () => {
    render(
      <BranchHeadlineCards
        detail={detail({
          canonicalMetrics: metricBundle({
            abandonmentTimeMs: noData(),
            leadTimeMs: notApplicable(),
            locPerDollar: complete(21),
          }),
        })}
      />
    );

    expect(screen.getByText("21")).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("marks a partial canonical value and carries its disclosure", () => {
    render(
      <BranchHeadlineCards
        detail={detail({
          canonicalMetrics: metricBundle({ locPerDollar: partial(18.5) }),
        })}
      />
    );

    expect(screen.getByText("19*")).toBeInTheDocument();
    expect(
      screen.getByText((content) =>
        content.includes(BranchMetricDisclosure.DefaultIncomplete)
      )
    ).toBeInTheDocument();
  });

  it("humanizes only the multi-day headline lead time", () => {
    render(
      <BranchHeadlineCards
        detail={detail({
          canonicalMetrics: metricBundle({
            abandonmentTimeMs: complete(333_601_000),
            leadTimeMs: partial(333_601_000),
          }),
        })}
      />
    );

    expect(screen.getByText("3d 20h*")).toBeInTheDocument();
    expect(screen.getByText("5560m 1s")).toBeInTheDocument();
  });
});

describe("BranchMultiPrNotice", () => {
  it("lists every linked pull request without blocking the page", () => {
    render(<BranchMultiPrNotice linkedPrNumbers={[42, 43]} />);
    expect(screen.getByRole("note")).toHaveTextContent("#42, #43");
  });
});

describe("BranchPropertiesPanel", () => {
  it("keeps Reviewer and selected-PR title out of Properties", async () => {
    const user = userEvent.setup();
    render(
      <BranchPropertiesPanel
        detail={detail({ prNumber: 42, prTitle: SELECTED_PR_TITLE })}
      />
    );

    await user.click(getBranchPropertiesToggle());
    expect(screen.queryByText("Reviewer")).not.toBeInTheDocument();
    expect(screen.queryByText(SELECTED_PR_TITLE)).not.toBeInTheDocument();
    expect(screen.getByText("Repository")).toBeInTheDocument();
    expect(screen.getByText("Branch")).toBeInTheDocument();
  });

  it("exposes collapsed and expanded state to assistive technology", async () => {
    const user = userEvent.setup();
    render(<BranchPropertiesPanel detail={detail()} />);
    const toggle = getBranchPropertiesToggle();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("uses one focusable disclosure for the collapsed header and preview", () => {
    const { container } = render(<BranchPropertiesPanel detail={detail()} />);

    const section = container.querySelector(".prd-props-section");
    expect(section).not.toBeNull();
    expect(
      section?.querySelectorAll("button, a, input, select, textarea")
    ).toHaveLength(1);
    expect(getBranchPropertiesToggle()).toHaveTextContent("Properties");
    expect(getBranchPropertiesToggle()).toHaveTextContent(detail().branchName);
  });

  it("keeps long Branch and repository values inside shrinkable nodes", async () => {
    const user = userEvent.setup();
    render(
      <BranchPropertiesPanel
        detail={detail({
          branchName: LONG_BRANCH_NAME,
          repoFullName: LONG_REPOSITORY_NAME,
        })}
      />
    );

    expect(screen.getByText(LONG_BRANCH_NAME)).toHaveClass("truncate");
    await user.click(getBranchPropertiesToggle());
    expect(screen.getByText(LONG_BRANCH_NAME)).toHaveAttribute(
      "title",
      LONG_BRANCH_NAME
    );
    expect(screen.getByText(LONG_REPOSITORY_NAME)).toHaveAttribute(
      "title",
      LONG_REPOSITORY_NAME
    );
  });
});

function getBranchPropertiesToggle(): HTMLElement {
  const toggle = screen.getByRole("button", { name: PROPERTIES_RE });
  if (!toggle) {
    throw new Error("Branch properties header toggle was not rendered");
  }
  return toggle;
}

function metricBundle(
  overrides: Partial<{
    abandonmentTimeMs: BranchMetricResult<number>;
    leadTimeMs: BranchMetricResult<number>;
    locPerDollar: BranchMetricResult<number>;
  }> = {}
) {
  const unavailable = unavailableMetric();
  return {
    abandonmentTimeMs: unavailable,
    idleTimeMs: unavailable,
    leadTimeMs: unavailable,
    locPerDollar: unavailable,
    phaseCostUsd: {
      [BranchVisibleLifecyclePhase.Build]: unavailable,
      [BranchVisibleLifecyclePhase.Review]: unavailable,
      [BranchVisibleLifecyclePhase.Rework]: unavailable,
    },
    totalCostUsd: unavailable,
    ...overrides,
  };
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

function notApplicable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.NotApplicable, value: null };
}

function noData(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.NoData, value: null };
}

function unavailableMetric(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}
