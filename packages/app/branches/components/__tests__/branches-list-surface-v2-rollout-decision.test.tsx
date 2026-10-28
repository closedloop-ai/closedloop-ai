import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import {
  GridviewRolloutDecisionOutcome,
  Surface,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceAnalyticsProvider } from "../../../shared/observability/surface-analytics-context";
import type { BranchRow } from "../../lib/branch-row";
import { BranchesListSurfaceV2 } from "../branches-list-surface-v2";
import { BRANCH_ROW_A, BRANCH_ROW_B } from "./branches-list-rows.fixtures";
import { branchesListSurfaceV2SummaryPropsFixture } from "./branches-list-surface-v2-props.fixtures";
import { branchesToolbarPropsFixture } from "./branches-toolbar-props.fixtures";

const VISIBLE_COLUMNS = new Set(["owner", "status", "lastActivity"]);

type SurfaceState = {
  isPending?: boolean;
  isPlaceholderData?: boolean;
  items?: BranchRow[];
};

describe("BranchesListSurfaceV2 rollout decision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("holds the decision until the flag resolves, then reports it once", () => {
    let resolved = false;
    // One adapter object across renders: the gate selects its resolver off the
    // adapter identity, so a fresh object would change hook order.
    const adapter: FeatureFlagAdapter = {
      useFeatureFlagEnabled: (key) =>
        resolved && key === GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
      useFeatureFlagResolved: () => resolved,
    };
    const capture = vi.fn();
    const { rerender } = render(surface({ adapter, capture }));
    expect(rolloutDecisions(capture)).toEqual([]);

    resolved = true;
    rerender(surface({ adapter, capture }));

    expect(rolloutDecisions(capture)).toEqual([
      expect.objectContaining({
        outcome: GridviewRolloutDecisionOutcome.Enabled,
        reason: BranchesListRolloutDecisionReason.RenderSettled,
        row_count: 2,
      }),
    ]);
  });

  it("measures each settle from the load that produced it", () => {
    const now = vi.spyOn(globalThis.performance, "now").mockReturnValue(100);
    const adapter = createStaticFeatureFlagAdapter({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    });
    const capture = vi.fn();
    const { rerender } = render(
      surface({ adapter, capture, state: { isPending: true, items: [] } })
    );

    now.mockReturnValue(400);
    rerender(surface({ adapter, capture }));
    expect(rolloutDecisions(capture)).toEqual([
      expect.objectContaining({ duration_ms: 300, row_count: 2 }),
    ]);

    now.mockReturnValue(5000);
    rerender(surface({ adapter, capture, state: { isPlaceholderData: true } }));
    now.mockReturnValue(5250);
    rerender(surface({ adapter, capture, state: { items: [BRANCH_ROW_A] } }));
    expect(rolloutDecisions(capture)[1]).toEqual(
      expect.objectContaining({ duration_ms: 250, row_count: 1 })
    );
  });

  it("reports no duration for a settle with no load behind it", () => {
    vi.spyOn(globalThis.performance, "now").mockReturnValue(100);
    const adapter = createStaticFeatureFlagAdapter({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    });
    const capture = vi.fn();
    const { rerender } = render(surface({ adapter, capture }));
    rerender(surface({ adapter, capture, state: { items: [BRANCH_ROW_A] } }));

    const decisions = rolloutDecisions(capture);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toHaveProperty("duration_ms", 0);
    expect(decisions[1]).not.toHaveProperty("duration_ms");
  });
});

function surface({
  adapter,
  capture,
  state = {},
}: {
  adapter: FeatureFlagAdapter;
  capture: Mock;
  state?: SurfaceState;
}) {
  const items = state.items ?? [BRANCH_ROW_A, BRANCH_ROW_B];
  return (
    <FeatureFlagAdapterProvider adapter={adapter}>
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <BranchesListSurfaceV2
          allRows={items}
          hasActiveFilters={false}
          hasWindow={false}
          isError={false}
          isPending={state.isPending ?? false}
          isPlaceholderData={state.isPlaceholderData ?? false}
          items={items}
          onPageChange={() => undefined}
          onPageSizeChange={() => undefined}
          onRetry={() => undefined}
          onShowAllTime={() => undefined}
          onSort={() => undefined}
          page={0}
          pageSize={25}
          sortBy="lastActivity"
          sortDir="desc"
          {...branchesListSurfaceV2SummaryPropsFixture()}
          toolbar={branchesToolbarPropsFixture({
            rows: items,
            visibleColumns: VISIBLE_COLUMNS,
          })}
          total={items.length}
          totalPages={1}
          visibleColumns={VISIBLE_COLUMNS}
        />
      </SurfaceAnalyticsProvider>
    </FeatureFlagAdapterProvider>
  );
}

/** The render-settled decisions; the parity hook reports other reasons. */
function rolloutDecisions(capture: Mock): unknown[] {
  return capture.mock.calls
    .filter(
      ([event, properties]) =>
        event === SurfaceAnalyticsEvent.GridviewRolloutDecision &&
        properties.reason === BranchesListRolloutDecisionReason.RenderSettled
    )
    .map(([, properties]) => properties);
}
