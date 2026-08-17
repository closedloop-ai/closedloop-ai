/**
 * @file pack-detail-merged-prs-adapter.test.tsx
 * @description ISS-6462 (wongk, #5096 review) — the DESKTOP half of the
 * adapter→render regression for the Packs Performance "Merged PRs" tile.
 *
 * `PackDetail` is shared, so the shared component test
 * (`packages/app/packs/components/__tests__/pack-detail.merged-prs-truncation.test.tsx`)
 * covers the render once and `plugin-pack-view.test.ts` covers
 * `packAnalyticsToBlocks` once. Neither covers the JOIN: the shared test is
 * handed an already-mapped block, and the mapper test never reaches a render.
 * This drives the desktop path end to end — the `PackAnalyticsResponse` this
 * renderer gets over IPC, through the real adapter, into the real tile.
 *
 * The web adapter's twin of this lives beside the shared component test; the
 * IPC boundary one layer further out is `test/pack-analytics-ipc-transform.test.ts`.
 * Together they cover the chain wire → IPC schema → adapter → tile.
 */
import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import { PackDetail } from "@repo/app/packs/components/pack-detail";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import { mockPackViews } from "@repo/app/packs/lib/pack-view-mock";
import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { packAnalyticsToBlocks } from "../plugin-pack-view";

const CONTEXT = createPacksContext(PacksMode.DesktopTeam);
const BASE_PACK = mockPackViews[0];
const MERGED_PRS_LABEL = "Merged PRs";
/** Distinct merged PRs found inside a capped scan: a FLOOR, not a total. */
const MERGED_PRS_FLOOR = 996;

function makeAnalytics(
  over: Partial<PackAnalyticsResponse> = {}
): PackAnalyticsResponse {
  return {
    deviceCount: 12,
    efficiencyTrend: [],
    invocations: 1284,
    locDelta: null,
    locPerDollar: 3.2,
    mergedPrs: MERGED_PRS_FLOOR,
    owners: ["Maya Chen"],
    packId: "code",
    qualityDelta: null,
    qualityScore: null,
    sessions: 7247,
    successDelta: null,
    successRate: null,
    tokenEfficiencyDelta: null,
    ...over,
  };
}

/** Render the Performance tab from what the DESKTOP adapter produced. */
function renderFromAnalytics(analytics: PackAnalyticsResponse): void {
  const { performance, teamUsage } = packAnalyticsToBlocks(analytics);
  const nav = createMemoryNavigation({
    initialPath: "/packs/code?tab=performance",
    orgSlug: "org-test",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const pack: PackView = { ...BASE_PACK, performance, teamUsage };
  render(<PackDetail context={CONTEXT} pack={pack} />, { wrapper });
}

/** The rendered headline of the tile whose label is "Merged PRs". */
function mergedPrsTileText(): string {
  const card = screen.getByText(MERGED_PRS_LABEL).closest("[data-slot='card']");
  if (!card) {
    throw new Error("the Merged PRs label is not inside a card");
  }
  const title = card.querySelector("[data-slot='card-title']");
  if (!title) {
    throw new Error("the Merged PRs card rendered no value");
  }
  return title.textContent?.trim() ?? "";
}

describe("Desktop Packs Merged PRs tile, through the IPC adapter (ISS-6462)", () => {
  it("renders a declared cap as a floor", () => {
    renderFromAnalytics(makeAnalytics({ mergedPrsTruncated: true }));

    expect(mergedPrsTileText()).toBe("996+");
  });

  it("renders a declared whole-cohort count bare, so the marker means something", () => {
    renderFromAnalytics(makeAnalytics({ mergedPrsTruncated: false }));

    expect(mergedPrsTileText()).toBe("996");
  });

  it("invents no cap when the response never declared its coverage", () => {
    // The version-skew case the field exists for: a cloud predating the
    // disclosure applies the same cap and simply cannot report it. A `+` here
    // would be this renderer asserting a cap nobody reported.
    const { performance } = packAnalyticsToBlocks(makeAnalytics());
    renderFromAnalytics(makeAnalytics());

    // The headline cannot tell undeclared from whole-cohort — both print "996".
    // The mapped state can, and an adapter folding the omission to `false` reds
    // right here rather than shipping a silent full-cohort claim.
    expect(performance.mergedPrsTruncated).toBeUndefined();
    expect(mergedPrsTileText()).toBe("996");
  });
});
