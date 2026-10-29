import { ArtifactTagAvailability } from "@repo/api/src/types/tag";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { stubResponsiveNarrowViewport } from "@repo/app/test/mocks/responsive-narrow-viewport";
import { pinSessionFixtureClock } from "@repo/app/test/mocks/session-fixture-clock";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSIONS_TAGS_COLUMN_ID } from "../../../lib/sessions-table-columns";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-8712 (tamsinb review): the View menu and the GRID must answer the Tags
 * gate the same way.
 *
 * `useSessionsListColumns` reads `sessions-artifact-tags` where it derives both
 * the View menu's toggleable column list and the grid's `renderedSpecs`. The
 * earlier broken shape gave the host-resolved gate only to the menu derivation;
 * the grid derivation fell back to `surfaceGates(undefined)`, which answers only
 * `grid-table-v2`. With the flag ON the menu offered a Tags switch that the grid
 * then dropped: the user flips it and nothing appears. That is the dead-toggle
 * shape the shared derivation exists to prevent.
 *
 * Asserted on the RENDERED grid, with the seam wired and the column asked for by
 * a controlling host, because that is the only state the defect showed in: the
 * menu entry was correct throughout, so a test of the menu alone passes on the
 * broken build. The flag-OFF sibling is what stops the flag-ON assertion passing
 * vacuously — without it, a regression that renders Tags unconditionally is
 * indistinguishable from the fix.
 */

const ROWS: SessionTableRow[] = [
  createSessionTableRowFixture({
    id: "session-1",
    name: "Session One",
    status: "Active",
    tagAvailability: ArtifactTagAvailability.Available,
    tags: [],
  }),
];

function renderTagsSeam(row: SessionTableRow) {
  return (
    <span data-testid="host-tags-renderer">
      tags-seam <button type="button">Edit tags for {row.name}</button>
    </span>
  );
}

/** A controlling host that has the column switched ON — Tags is default-off. */
const CONTROLLED_VIEW_WITH_TAGS = {
  value: {
    sortBy: null,
    sortDir: "asc" as const,
    grouping: EMPTY_TABLE_GROUPING,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    dateRange: DEFAULT_DATE_RANGE,
    visibleColumnIds: new Set(["status", SESSIONS_TAGS_COLUMN_ID]),
    page: 0,
    scopeUserId: null,
  },
  onChange: () => undefined,
};

let restoreContainerWidth: (() => void) | null = null;
let restoreViewport: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
  restoreViewport?.();
  restoreViewport = null;
});

pinSessionFixtureClock();

function renderSurface(
  flagOn: boolean,
  options: { narrow?: boolean; renderTags?: boolean } = {}
) {
  // Above the 768px card-fallback breakpoint so the CSS grid renders and the
  // column headers exist to assert on at all.
  restoreContainerWidth = stubContainerWidthPx(options.narrow ? 390 : 1440);
  if (options.narrow) {
    restoreViewport = stubResponsiveNarrowViewport(true).restore;
  }
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [
          ...(options.narrow ? [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY] : []),
          ...(flagOn ? [SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY] : []),
        ],
      })}
    >
      <SessionsListSurfaceV2
        controlledView={CONTROLLED_VIEW_WITH_TAGS}
        mode={options.narrow ? "compact" : undefined}
        renderTags={options.renderTags === false ? undefined : renderTagsSeam}
        rows={ROWS}
        usage={undefined}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("SessionsListSurfaceV2 Tags gate reaches the grid, not only the menu", () => {
  it("renders the Tags column when the flag is on and the host wired the seam", () => {
    const { container } = renderSurface(true);

    expect(
      container.querySelector(`[data-column-id="${SESSIONS_TAGS_COLUMN_ID}"]`)
    ).not.toBeNull();
    // The column's own CELL, not just its header: a track rendered without the
    // seam's content is the em-dash column the seam requirement exists to stop.
    expect(container.textContent).toContain("tags-seam");
    // Not because the grid renders everything asked for — an ungated column the
    // controlled view did NOT name is still absent.
    expect(container.querySelector('[data-column-id="repo"]')).toBeNull();
  });

  it("renders no Tags column when the flag is off, seam and host request notwithstanding", () => {
    const { container } = renderSurface(false);

    expect(
      container.querySelector(`[data-column-id="${SESSIONS_TAGS_COLUMN_ID}"]`)
    ).toBeNull();
    expect(container.textContent).not.toContain("tags-seam");
    // And not because nothing rendered — the ungated column the view named is
    // still there, so the absence above is the gate.
    expect(container.querySelector('[data-column-id="status"]')).not.toBeNull();
  });

  // ISS-12959 (2026-10-19 operator Asana observation): the narrow row is the
  // status icon and title, so Tags render only in the wide column.
  it("renders no Tags in the narrow row even when the Tags gate and seam hold", () => {
    const on = renderSurface(true, { narrow: true });
    expect(on.container.querySelector('[role="grid"]')).not.toBeNull();
    expect(on.queryByTestId("host-tags-renderer")).not.toBeInTheDocument();
    expect(
      on.queryByRole("button", { name: "Edit tags for Session One" })
    ).not.toBeInTheDocument();
  });
});
