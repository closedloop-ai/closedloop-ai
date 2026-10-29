import { BRANCHES_LISTING_LOADING_PARITY_FLAG_KEY } from "@repo/api/src/types/branches-listing-loading-parity-flag";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderSessionsListLoading } from "../../../agents/components/sessions/sessions-list-loading-body";
import { BRANCHES_RETRY_LABEL } from "../../../branches/components/branches-empty-state";
import { BranchesListStateView } from "../../../branches/components/branches-list-state-view";
import { BranchesListStateKind } from "../../../branches/lib/branch-list-state";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import type { LoadingStallPhase } from "../../lib/loading-stall-phase";

/**
 * ISS-10645 — the two listings' loading treatments, compared against EACH OTHER.
 *
 * Holding each independently against a constant is what let them diverge: both
 * files passed their own suite while Sessions escalated a wedged read and
 * Branches showed one line of centred text at 2 seconds and at 2 minutes. These
 * assertions read one surface's DOM and demand the other's match it, so a change
 * to either that the other does not follow reddens here.
 */

const TEST_ID = "loading-region";

function renderSessionsLoading(stallPhase: LoadingStallPhase) {
  return render(
    <div data-testid={TEST_ID}>
      {renderSessionsListLoading({
        hasData: false,
        isLoading: true,
        loadingLabel: undefined,
        stallPhase,
      })}
    </div>
  );
}

function renderBranchesLoading(stallPhase: LoadingStallPhase) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [BRANCHES_LISTING_LOADING_PARITY_FLAG_KEY],
      })}
    >
      <div data-testid={TEST_ID}>
        <BranchesListStateView
          onRetry={() => undefined}
          onShowAllTime={() => undefined}
          stallPhase={stallPhase}
          state={{ kind: BranchesListStateKind.Loading }}
        />
      </div>
    </FeatureFlagAdapterProvider>
  );
}

/**
 * The rendered loading region with every listing-specific WORD removed, so what
 * is left is the treatment itself: element shape, ARIA, and the classes that
 * decide how it looks. Two listings that "look identical" must produce the same
 * skeleton here; only their nouns may differ.
 */
function treatmentSkeleton(root: HTMLElement): string {
  const region = root.querySelector("[data-testid='loading-region']");
  if (!region) {
    throw new Error("loading region missing");
  }
  return [...region.querySelectorAll("*")]
    .map((node) =>
      [
        node.tagName,
        node.getAttribute("role") ?? "",
        node.getAttribute("aria-live") ?? "",
        node.getAttribute("class") ?? "",
      ].join("|")
    )
    .join("\n");
}

describe("ISS-10645 Sessions/Branches loading parity", () => {
  it.each(["none", "soft", "hard"] as const)(
    "renders the same treatment on both listings at the %s stall phase",
    (stallPhase) => {
      const sessions = renderSessionsLoading(stallPhase);
      const sessionsSkeleton = treatmentSkeleton(sessions.container);
      sessions.unmount();
      const branches = renderBranchesLoading(stallPhase);
      const branchesSkeleton = treatmentSkeleton(branches.container);

      expect(branchesSkeleton).toBe(sessionsSkeleton);
      // A positive sibling for the comparison: an empty region would compare
      // equal to an empty region, which would prove nothing at all.
      expect(sessionsSkeleton.length).toBeGreaterThan(0);
    }
  );

  it.each(["none", "soft", "hard"] as const)(
    "keeps pending Branches at %s loading without Retry",
    (phase) => {
      renderBranchesLoading(phase);
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: BRANCHES_RETRY_LABEL })
      ).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    }
  );
});
