import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  TABLE_PAGE_SIZE_OPTIONS,
  TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
} from "@repo/design-system/components/ui/table-page-size-select";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";
import { renderWithNav } from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-9216 — the rows-per-page ladder this surface renders is its own.
 *
 * It used to arrive as an optional `pageSizeOptions` prop: the web page passed
 * the shared 25/50/100 list explicitly and the desktop view passed nothing, so
 * the two shells drew their choices from different places and agreed only by
 * coincidence. The prop is gone; this asserts the ladder still reaches the
 * control, so removing the seam did not quietly remove the choices with it.
 */

const ROWS: readonly SessionTableRow[] = [createSessionTableRowFixture()];

const VIEW: SessionsListViewState = {
  // "all": the shared row fixture is written against a fixed instant, which a
  // relative preset would window out and leave the surface with no rows to page.
  dateRange: "all",
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  sortBy: null,
  sortDir: "asc",
  visibleColumnIds: new Set(["status"]),
};

async function openLadder(extendedLadderEnabled: boolean) {
  renderWithNav(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: extendedLadderEnabled
          ? [TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <SessionsListSurfaceV2
        controlledView={{ onChange: () => undefined, value: VIEW }}
        onPageSizeChange={() => undefined}
        rows={ROWS}
        usage={undefined}
      />
    </FeatureFlagAdapterProvider>
  );

  await userEvent.click(
    screen.getByRole("combobox", { name: "Rows per page" })
  );

  return screen.getAllByRole("option").map((option) => option.textContent);
}

describe("SessionsListSurfaceV2 page-size ladder", () => {
  it("offers the surface's own ladder with no host prop in the chain", async () => {
    expect(await openLadder(false)).toStrictEqual(
      TABLE_PAGE_SIZE_OPTIONS.map((size) => `${size} / page`)
    );
  });

  /**
   * ISS-9692 — 250 and 500 are selectable with `table-page-size-ladder` on, and
   * absent with it off (the case above). Asserted on the RENDERED options, so a
   * ladder that grew in the constant but never reached the control fails here.
   */
  it("offers 250 and 500 once the extended ladder is enabled", async () => {
    expect(await openLadder(true)).toStrictEqual(
      TABLE_PAGE_SIZE_OPTIONS_EXTENDED.map((size) => `${size} / page`)
    );
  });
});
