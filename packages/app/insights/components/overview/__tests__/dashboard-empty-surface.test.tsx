import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY,
  MERGED_LOC_LABEL,
} from "@repo/api/src/types/insights-loc-terminology-flag";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TileDescriptor } from "../../../lib/tile-catalog";
import { DashboardEmptySurface } from "../dashboard-empty-surface";

/**
 * ISS-10567 (whitlockk review) — the two facts the promoted skeleton has to get
 * right about tiles it is NOT populating.
 *
 * Both are the same rule stated twice: the empty card and the filled card are
 * the same card either side of first data, so the skeleton resolves each tile
 * exactly as `StatsKpiRow` does — the catalog's title, and three of them are
 * GitHub truth, so an "empty" caption over an unasked question is a
 * completed-zero claim.
 */

// The catalog's names. Spelled as literals rather than read back through
// `getTile`, which is the thing under test's own source for them.
const CATALOG_KLOC_LABEL = "KLOC merged";
const CATALOG_PR_SIZE_LABEL = "Median PR size";
const CATALOG_MERGED_LABEL = "Merged PRs";
const MERGED_EMPTY_CAPTION = "No merged PRs yet";
const UNAVAILABLE_MESSAGE =
  "This GitHub metric is unavailable for the selected scope.";
const CONNECT_CTA =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardCtaLabel ??
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel;
const GITHUB_TRUTH_TILE_IDS = new Set<string>([
  "kpi:merged",
  "kpi:kloc",
  "kpi:pr-size",
]);

function allAvailable() {
  return { state: BranchKpiState.Available };
}

function gateGitHubTruth(tile: TileDescriptor) {
  return {
    state: GITHUB_TRUTH_TILE_IDS.has(tile.id)
      ? BranchKpiState.Gated
      : BranchKpiState.Available,
  };
}

function unavailableGitHubTruth(tile: TileDescriptor) {
  return {
    state: GITHUB_TRUTH_TILE_IDS.has(tile.id)
      ? BranchKpiState.Unavailable
      : BranchKpiState.Available,
  };
}

describe("DashboardEmptySurface tile labels", () => {
  /**
   * tamsinb, ISS-12638: `StatsKpiRow` runs every tile through
   * `resolveTileVocabulary`; this surface read the raw catalog. With
   * `insights-loc-terminology` on, the empty card said "KLOC merged" and the
   * populated one "Merged LOC" — the card renaming itself on first data, which
   * is the one thing this file's header says cannot happen.
   */
  it("resolves the vocabulary the populated row resolves, under the flag", () => {
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY],
        })}
      >
        <DashboardEmptySurface readsCloud={false} />
      </FeatureFlagAdapterProvider>
    );

    expect(screen.getByText(MERGED_LOC_LABEL)).toBeInTheDocument();
    // Paired with the presence assertion above on the same locator, so an
    // absence that only ever matched nothing cannot pass for a guarantee.
    expect(screen.queryByText(CATALOG_KLOC_LABEL)).toBeNull();
  });

  it("wears the catalog's title for every headline tile", () => {
    render(<DashboardEmptySurface readsCloud={false} />);

    expect(screen.getByText(CATALOG_KLOC_LABEL)).toBeInTheDocument();
    expect(screen.getByText(CATALOG_PR_SIZE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(CATALOG_MERGED_LABEL)).toBeInTheDocument();
  });
});

describe("DashboardEmptySurface tile availability", () => {
  /**
   * How many times the completed-zero caption is on the page with every tile
   * Available. The KPI card is ONE of them — the two PR charts carry the same
   * sentence as their own empty body — so the availability cases below assert
   * this count MINUS ONE rather than zero, which is what actually pins that the
   * KPI card's caption was the one replaced.
   */
  function availableMergedCaptionCount(): number {
    const view = render(
      <DashboardEmptySurface
        getTileAvailability={allAvailable}
        readsCloud={false}
      />
    );
    const count = screen.queryAllByText(MERGED_EMPTY_CAPTION).length;
    view.unmount();
    return count;
  }

  it("offers the connect ask instead of a completed-zero caption on a gated GitHub-truth tile", () => {
    const baseline = availableMergedCaptionCount();
    expect(baseline).toBeGreaterThan(0);

    render(
      <DashboardEmptySurface
        getTileAvailability={gateGitHubTruth}
        githubConnect={{
          action: GitHubConnectAction.Connect,
          onConnect: () => undefined,
        }}
        readsCloud={false}
      />
    );

    expect(screen.getAllByText(CONNECT_CTA).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(MERGED_EMPTY_CAPTION)).toHaveLength(
      baseline - 1
    );
    // An ask names the metric the CATALOG offers.
    expect(screen.getByText(CATALOG_KLOC_LABEL)).toBeInTheDocument();
    expect(screen.getByText(CATALOG_MERGED_LABEL)).toBeInTheDocument();
  });

  it("states the scope message on an unavailable GitHub-truth tile", () => {
    const baseline = availableMergedCaptionCount();

    render(
      <DashboardEmptySurface
        getTileAvailability={unavailableGitHubTruth}
        readsCloud={false}
      />
    );

    expect(screen.getAllByText(UNAVAILABLE_MESSAGE).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(MERGED_EMPTY_CAPTION)).toHaveLength(
      baseline - 1
    );
  });
});

describe("DashboardEmptySurface Recent Sessions copy", () => {
  it("names every analyzed source on a local empty dashboard (ISS-11346)", () => {
    render(<DashboardEmptySurface readsCloud={false} />);

    expect(
      screen.getByText(
        "Start using Claude Code, Codex, Cursor, Copilot, or OpenCode on this Mac and your sessions will appear here automatically — computed locally, nothing uploaded."
      )
    ).toBeInTheDocument();
  });
});
