import {
  type BranchAnalytics,
  type BranchKpi,
  BranchKpiState,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail as detail,
  makeBranchSession as session,
} from "../../__tests__/branch-fixtures";
import { BranchCostToMerge } from "../branch-cost-to-merge";
import { BranchHeadlineCards } from "../branch-headline-cards";
import { BranchLeadTimeWaterfall } from "../branch-lead-time-waterfall";
import { BranchMultiPrNotice } from "../branch-multi-pr-notice";
import { BranchPropertiesPanel } from "../branch-properties-panel";

const IN_PROGRESS_RE = /in progress/i;
const BASELINE_UNAVAILABLE_RE = /baseline unavailable/;
const MULTI_PR_COST_RE = /attributed per phase/i;
const TWO_PRS_RE = /2 linked pull requests/;
const PR_LIST_RE = /#42, #43/;
const PROPERTIES_RE = /properties/i;
const LONG_BRANCH_NAME =
  "feature/narrow-responsive-properties-panel-with-a-very-long-branch-name";
const LONG_REPOSITORY_NAME =
  "closedloop-ai/repository-with-a-very-long-name-for-responsive-panels";
const LONG_PR_TITLE =
  "Keep the properties panel readable when pull request titles are unusually long";

function kpi(over: Partial<BranchKpi> = {}): BranchKpi {
  return {
    value: 1,
    state: BranchKpiState.Available,
    baseline30d: null,
    deltaPct: null,
    ...over,
  };
}

function analytics(over: Partial<BranchAnalytics> = {}): BranchAnalytics {
  return {
    viewerScope: "self",
    medianPrSize: kpi(),
    mergeRate: kpi(),
    medianTimeToMergeMs: kpi(),
    activePrCount: kpi(),
    mergedCount: kpi(),
    leadTimeForChangeMs: kpi(),
    locPerDollar: kpi(),
    totalSpendUsd: kpi(),
    activeBranchCount: kpi(),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
    ...over,
  };
}

describe("BranchCostToMerge (D4)", () => {
  it("renders the cost section with the priced total and a Build phase", () => {
    render(
      <BranchCostToMerge
        detail={detail({
          estimatedCostUsd: 1.5,
          mergedAt: "2026-06-11T00:00:00.000Z",
          sessions: [session({ estimatedCostUsd: 1.5 })],
        })}
      />
    );
    expect(screen.getByText("Cost to merge")).toBeInTheDocument();
    expect(screen.getByText("$1.50")).toBeInTheDocument();
    expect(screen.getByText("Build")).toBeInTheDocument();
  });

  it('heads "Cost to date" while the branch is unmerged', () => {
    render(
      <BranchCostToMerge
        detail={detail({ estimatedCostUsd: 1.5, mergedAt: null })}
      />
    );
    expect(screen.getByText("Cost to date")).toBeInTheDocument();
    expect(screen.queryByText("Cost to merge")).not.toBeInTheDocument();
  });

  it("suppresses the per-phase split with a note when multi-PR", () => {
    render(
      <BranchCostToMerge
        detail={detail({ estimatedCostUsd: 1.5, sessions: [session()] })}
        suppressSplits
      />
    );
    expect(screen.queryByText("Build")).not.toBeInTheDocument();
    expect(screen.getByText(MULTI_PR_COST_RE)).toBeInTheDocument();
  });
});

describe("BranchLeadTimeWaterfall (D5)", () => {
  it('shows "in progress" when the branch has not merged', () => {
    render(
      <BranchLeadTimeWaterfall detail={detail({ sessions: [session()] })} />
    );
    expect(screen.getByText(IN_PROGRESS_RE)).toBeInTheDocument();
  });

  it("renders the multi-PR asterisk", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={detail({ sessions: [session()], multiPrWarning: true })}
      />
    );
    expect(screen.getByText("*")).toBeInTheDocument();
  });
});

describe("BranchHeadlineCards (D6)", () => {
  it("renders Value per $ and Lead time cards", () => {
    render(<BranchHeadlineCards detail={detail({ sessions: [session()] })} />);
    expect(screen.getByText("Value per $")).toBeInTheDocument();
    expect(screen.getByText("Lead time for change")).toBeInTheDocument();
  });

  it("labels baseline unavailable and shows no delta when analytics is absent", () => {
    render(<BranchHeadlineCards detail={detail({ sessions: [session()] })} />);
    expect(screen.queryByText("vs. prior 30 days")).not.toBeInTheDocument();
    expect(screen.getAllByText(BASELINE_UNAVAILABLE_RE).length).toBeGreaterThan(
      0
    );
  });

  it("shows a 30-day delta when the KPI carries a baseline", () => {
    render(
      <BranchHeadlineCards
        analytics={analytics({
          locPerDollar: kpi({ baseline30d: 100, deltaPct: 12 }),
          leadTimeForChangeMs: kpi({ baseline30d: null, deltaPct: null }),
        })}
        detail={detail({ sessions: [session()] })}
      />
    );
    expect(screen.getByText("vs. prior 30 days")).toBeInTheDocument();
  });
});

describe("BranchMultiPrNotice (D7)", () => {
  it("renders a non-blocking note listing the linked PRs", () => {
    render(<BranchMultiPrNotice linkedPrNumbers={[42, 43]} />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(TWO_PRS_RE);
    expect(note).toHaveTextContent(PR_LIST_RE);
  });
});

describe("BranchPropertiesPanel (D8)", () => {
  it("renders collapsed by default showing preview chips, not grid labels", () => {
    render(<BranchPropertiesPanel detail={detail()} />);
    // Collapsed → preview chips (branch name); no grid labels yet.
    expect(screen.getByText("feature/x")).toBeInTheDocument();
    expect(screen.queryByText("Reviewer")).not.toBeInTheDocument();
  });

  it("shows the status label in the preview", () => {
    render(
      <BranchPropertiesPanel detail={detail({ status: BranchStatus.Merged })} />
    );
    expect(screen.getByText("Merged")).toBeInTheDocument();
  });

  it("expands to the grid showing only the wired fields", async () => {
    const user = userEvent.setup();
    render(<BranchPropertiesPanel detail={detail()} />);
    await user.click(getBranchPropertiesToggle());
    // Wired fields render; Reviewer keeps its explicit empty state.
    expect(screen.getByText("Repository")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    // The unwired placeholder fields are hidden, not fabricated.
    for (const removed of [
      "Owner",
      "Base",
      "Checks",
      "Behind / ahead",
      "Approvals",
      "Story points",
      "Issues",
    ]) {
      expect(screen.queryByText(removed)).not.toBeInTheDocument();
    }
  });

  it("exposes the expanded state to assistive tech via aria-expanded", async () => {
    const user = userEvent.setup();
    render(<BranchPropertiesPanel detail={detail()} />);
    const toggle = screen.getByRole("button", { name: PROPERTIES_RE });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps long branch and pull request values inside shrinkable text nodes", async () => {
    const user = userEvent.setup();
    render(
      <BranchPropertiesPanel
        detail={detail({
          branchName: LONG_BRANCH_NAME,
          prNumber: 1234,
          prTitle: LONG_PR_TITLE,
          repoFullName: LONG_REPOSITORY_NAME,
        })}
      />
    );

    const previewBranch = screen.getByText(LONG_BRANCH_NAME);
    expect(previewBranch).toHaveClass("truncate");
    expect(previewBranch.closest(".sd3-pp")).toHaveAttribute(
      "title",
      LONG_BRANCH_NAME
    );

    await user.click(getBranchPropertiesToggle());

    expect(screen.getByText(LONG_BRANCH_NAME)).toHaveAttribute(
      "title",
      LONG_BRANCH_NAME
    );
    expect(screen.getByText(LONG_REPOSITORY_NAME)).toHaveAttribute(
      "title",
      LONG_REPOSITORY_NAME
    );
    const prTitle = screen.getByText(LONG_PR_TITLE);
    expect(prTitle).toHaveClass("truncate");
    expect(prTitle.closest(".sd3-pp")).toHaveAttribute(
      "title",
      `#1234 ${LONG_PR_TITLE}`
    );
  });
});

function getBranchPropertiesToggle() {
  const propertiesToggle = screen
    .getAllByRole("button", { name: PROPERTIES_RE })
    .find((element) => element.classList.contains("prd-props-header"));
  if (!propertiesToggle) {
    throw new Error("Branch properties header toggle was not rendered");
  }
  return propertiesToggle;
}
