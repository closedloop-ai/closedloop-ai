import { BranchKpiState } from "@repo/api/src/types/branch";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  getTile,
  INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
} from "../../lib/tile-catalog";
import { InsightsTile } from "../insights-tile";

/**
 * ISS-12638: a gated chart tile on the dashboard wears the same message as the
 * gated cards beside it, not the Insights grid's centred wording.
 */

const CONNECT_COPY = GITHUB_CONNECT_COPY[GitHubConnectAction.Connect];
const CONNECT_CTA = CONNECT_COPY.cardCtaLabel ?? CONNECT_COPY.ctaLabel;

function renderGatedChart(withSupportingCopy: boolean) {
  const tile = getTile(INSIGHTS_PR_BY_REPO_CHART_TILE_ID);
  if (!tile) {
    throw new Error("repo chart tile missing from the catalog");
  }
  render(
    <InsightsTile
      availability={{ state: BranchKpiState.Gated }}
      githubConnect={{
        action: GitHubConnectAction.Connect,
        onConnect: vi.fn(),
      }}
      pinned={false}
      sections={{}}
      tile={tile}
      withSupportingCopy={withSupportingCopy}
    />
  );
}

describe("gated chart tile on the dashboard (ISS-12638)", () => {
  it("offers the card ask with its supporting sentence", () => {
    renderGatedChart(true);

    expect(
      screen.getByRole("button", { name: CONNECT_CTA })
    ).toBeInTheDocument();
    expect(
      screen.getByText(CONNECT_COPY.cardSupportingCopy ?? "")
    ).toBeInTheDocument();
  });

  it("keeps the Insights grid's own wording without the opt-in", () => {
    renderGatedChart(false);

    expect(
      screen.getByRole("button", { name: CONNECT_COPY.ctaLabel })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(CONNECT_COPY.cardSupportingCopy ?? "")
    ).not.toBeInTheDocument();
  });
});
