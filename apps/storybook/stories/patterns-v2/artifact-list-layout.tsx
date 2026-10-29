import { LayoutRegion } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell.story-fixtures";
import {
  GridTableListSurface,
  type GridTableListSurfaceMode,
} from "@repo/design-system/components/ui/grid-table-list-surface";

/**
 * The v2 artifact list page's layout: the page header over
 * `GridTableListSurface`, the band layout every v2 list shares
 * (`BranchesListSurfaceV2`, `SessionsListSurfaceV2`, the Documents index):
 * the toolbar band, the summary-card band, the scrolling table band and the
 * pagination footer. Every slot is an empty, named region: a pattern shows
 * where content goes, never the content.
 *
 * The surface measures its own width and picks a mode for the toolbar and the
 * rows together: the full toolbar beside the table at or above
 * `CARD_FALLBACK_BREAKPOINT`, the folded toolbar beside a card list below it.
 * Each region names the mode it was handed, so the two layouts read apart.
 *
 * Every artifact list pattern renders this (ISS-12171), and so does the
 * Surfaces entry of a list page with no new version yet.
 */
export function ArtifactListLayout({
  className = "h-dvh",
  selectionRail = false,
}: Readonly<{
  className?: string;
  /** The page has a selection rail band (Branches List, ISS-12305). */
  selectionRail?: boolean;
}>) {
  return (
    <div className={`flex min-h-0 flex-col bg-background ${className}`}>
      <LayoutRegion
        className="m-2 h-12 shrink-0"
        label="Page header"
        testId="page-header"
      />
      <GridTableListSurface
        bulkActions={
          selectionRail ? (
            <LayoutRegion
              className="mx-auto my-3 h-14 w-80 max-w-full shrink-0"
              label="Selection rail region"
              testId="selection-rail-region"
            />
          ) : null
        }
        className="min-h-0 flex-1"
        metrics={
          <LayoutRegion
            className="h-28"
            label="Summary cards region"
            testId="summary-region"
          />
        }
        pagination={
          <LayoutRegion
            className="h-10 w-full"
            label="Pagination region"
            testId="pagination-region"
          />
        }
        table={(mode) => (
          <LayoutRegion
            className="m-4 min-h-64"
            label={ROWS_LABEL[mode]}
            testId={`rows-region-${mode}`}
          />
        )}
        toolbar={(mode) => (
          <LayoutRegion
            className="h-9 w-full"
            label={TOOLBAR_LABEL[mode]}
            testId={`toolbar-region-${mode}`}
          />
        )}
      />
    </div>
  );
}

const TOOLBAR_LABEL: Record<GridTableListSurfaceMode, string> = {
  expanded: "Toolbar region",
  compact: "Toolbar region (folded)",
};

const ROWS_LABEL: Record<GridTableListSurfaceMode, string> = {
  expanded: "Table region",
  compact: "Card list region",
};
