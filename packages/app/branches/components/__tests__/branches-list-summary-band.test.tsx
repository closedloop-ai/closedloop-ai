import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "../../../github/lib/github-connect-copy";
import { GatedMetricIndicatorVariant } from "../../../shared/components/gated-metric-indicator";
import { BranchCohortNoticeKind } from "../../lib/branch-cohort-transparency";
import {
  BranchesListSummaryBand,
  type BranchesListSummaryBandProps,
} from "../branches-list-summary-band";
import { ConnectGitHubIndicator } from "../connect-github-indicator";

const CONNECT_GITHUB_BUTTON_NAME_PATTERN = /connect (?:to )?github/i;
/**
 * The sentence the retired band CTA carried (metric scope). Its `notice`
 * variant went with it (ISS-11274, tamsinb review), so the liveness mount below
 * uses `centered` — the layout that still ships — and the sentence is unchanged
 * either way, because scope and not variant selects it.
 * It is asserted ALONGSIDE the control's accessible name because the control
 * itself renders as a button on desktop (`onConnect`) and a link on web
 * (`actionHref`), and as neither when the host resolves no target at all — so a
 * button-only absence check would pass on a rendered informational ask. The
 * liveness case below uses the desktop `onConnect` shape because the web `href`
 * shape renders `@repo/navigation/link`, which needs a provider this mount has
 * no reason to stand up.
 */
const CONNECT_EXPLANATION =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].gatedMetricExplanation;

describe("BranchesListSummaryBand", () => {
  it("resolves the shipped connect control through these locators", () => {
    render(
      <ConnectGitHubIndicator
        connect={{
          action: GitHubConnectAction.Connect,
          onConnect: () => undefined,
        }}
        variant={GatedMetricIndicatorVariant.Centered}
      />
    );

    expect(screen.getByText(CONNECT_EXPLANATION)).toBeDefined();
    expect(
      screen.getByRole("button", { name: CONNECT_GITHUB_BUTTON_NAME_PATTERN })
    ).toBeDefined();
  });

  it("renders no connect-GitHub control when the host passes no githubConnect", () => {
    // The retry row is the positive control: it proves the band drew before the absences.
    render(<BranchesListSummaryBand {...BASE_PROPS} summaryAnalyticsErrored />);

    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.getByRole("alert")).toHaveAttribute("data-slot", "alert");
    expect(
      screen.getByText("Couldn't load the summary metrics.")
    ).toBeInTheDocument();
    expect(screen.queryByText(CONNECT_EXPLANATION)).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: CONNECT_GITHUB_BUTTON_NAME_PATTERN })
    ).toBeNull();
  });

  /**
   * tamsinb, ISS-12638: the strip's ask had nowhere to report its handoff on a
   * loaded list — the stalled-load slot's status mounts only while the blocking
   * read has produced nothing — so a refused sign-in or a connect that never
   * opened made the click look like it went nowhere.
   */
  it("renders the host's connect outcome beside the strip", () => {
    render(
      <BranchesListSummaryBand
        {...BASE_PROPS}
        githubConnectOutcome={<span>{CONNECT_OUTCOME_MARKER}</span>}
      />
    );

    expect(screen.getByText(CONNECT_OUTCOME_MARKER)).toBeDefined();
  });

  it("renders no outcome when the host has none to report", () => {
    render(<BranchesListSummaryBand {...BASE_PROPS} summaryAnalyticsErrored />);

    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.queryByText(CONNECT_OUTCOME_MARKER)).toBeNull();
  });
});

/** Stands in for the host's `DesktopConnectStatus`, which is renderer-owned. */
const CONNECT_OUTCOME_MARKER = "connect outcome slot";

const BASE_PROPS = {
  cohortNotice: { kind: BranchCohortNoticeKind.Hidden, total: 0 },
  comparisonSuppressedByFilter: false,
  dateRange: "7d",
  githubReturnStatus: null,
  onSummaryRetry: () => undefined,
  summaryAnalyticsErrored: false,
  summaryCards: undefined,
  summaryCardsErrored: false,
  summaryCardsPending: false,
  summaryCardsReloading: false,
} satisfies BranchesListSummaryBandProps;
