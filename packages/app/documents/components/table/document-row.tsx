"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import {
  AssigneeCell,
  DueDateCell,
  PriorityCell,
} from "@repo/app/documents/components/table/cells/edit-cells";
import { NameCell } from "@repo/app/documents/components/table/cells/name-cell";
import { buildRankSlot } from "@repo/app/documents/components/table/cells/rank-slot";
import { ScoreCell } from "@repo/app/documents/components/table/cells/score-cell";
import {
  ParentCell,
  ProjectCell,
  TypeCell,
  UpdatedCell,
} from "@repo/app/documents/components/table/cells/static-cells";
import { TagsCell } from "@repo/app/documents/components/table/cells/tags-cell";
import {
  RowEditContext,
  type RowEditHandlers,
} from "@repo/app/documents/components/table/row-edit-context";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import type { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import { getStringRouteParam } from "@repo/navigation/route-param";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { EllipsisIcon } from "lucide-react";
import { LoopCell } from "./loop-cell";

// ---- Unified row item type ----

/**
 * Discriminated union keyed on the row's actual artifact type (FEA-1763 /
 * PLN-874 Phase 2): `document` = DOCUMENT artifacts (all subtypes — PRD,
 * Plan, Feature; the subtype lives in `data.type`), `branch` = BRANCH
 * artifacts (PRs), `session` = SESSION artifacts. `project` rows are the
 * non-artifact grouping rows used by multi-project surfaces. Per-type
 * presentation (badge, icon, route, capabilities) comes from
 * `row-type-registry.ts`; cell renderers live under `table/cells/`.
 */
export type DocumentRowItem =
  | {
      kind: "document";
      data: DocumentRowData;
      children?: DocumentRowItem[];
    }
  | { kind: "project"; data: ProjectWithDetails; children?: DocumentRowItem[] }
  | {
      kind: "branch";
      data: Artifact;
      children?: DocumentRowItem[];
    }
  | {
      kind: "session";
      data: Artifact;
      children?: DocumentRowItem[];
    };

// ---- Column to cell mapping ----

const CELL_RENDERERS: Record<
  DocumentColumn,
  React.ComponentType<{ item: DocumentRowItem }>
> = {
  [Col.Type]: TypeCell,
  [Col.Parent]: ParentCell,
  [Col.DueDate]: DueDateCell,
  [Col.Assignee]: AssigneeCell,
  [Col.Priority]: PriorityCell,
  [Col.Score]: ScoreCell,
  [Col.Loop]: LoopCell,
  [Col.Tags]: TagsCell,
  [Col.Updated]: UpdatedCell,
  [Col.Project]: ProjectCell,
};

// ---- Main row component ----

export type DocumentRowProps = {
  item: DocumentRowItem;
  visibleColumns: DocumentColumn[];
  showCheckbox?: boolean;
  isSelected?: boolean;
  onSelectionChange?: (id: string, checked: boolean) => void;
  onMoreMenu?: (item: DocumentRowItem, anchor: HTMLElement) => void;
  /** Custom content for the more menu cell (replaces the default ellipsis button). */
  moreMenuContent?: React.ReactNode;
  /** When defined, renders a chevron for expand/collapse (grouped "All" view). */
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  /**
   * Nesting depth of this row in the tree (0 = root). Each level indents the
   * name cell by one slot width so hierarchy is visible at any depth.
   */
  indentDepth?: number;
  /** Edit handlers for inline cell editing. */
  editHandlers?: RowEditHandlers;
  /** Parent entity title for this row, used by the Parent column cell. */
  parentTitle?: string;
  /** Parent entity route for this row, used by the Parent column cell. */
  parentHref?: string | null;
  /** Reserve the chevron slot even when the row has no children. */
  reserveChevronSlot?: boolean;
  /**
   * Reserve an empty rank slot so this row's grid (and therefore its indent)
   * stays aligned with sibling rows that render a rank slot. Used by child
   * rows on stack-rank surfaces: they are not themselves rankable (no
   * `rankInteractionMode`), but without the slot the 28px rank column on root
   * rows would exactly cancel one level of child indentation.
   */
  reserveRankSlot?: boolean;
  /** When true, checkboxes are always visible (not just on hover). */
  selectMode?: boolean;
  /**
   * Render the bottom border of this row. Defaults to true; tree groups pass
   * false for every row except the group's last visible one, so rows belonging
   * to the same root read as one visual block.
   */
  showBottomBorder?: boolean;
  /**
   * Stack-rank interaction state for this row (PRD-421 / PLN-755 Phase E).
   * Controls whether the rank slot at the start of the name cell is reserved
   * and, if so, what it renders:
   *  - `Enabled`         — render the `dragHandle` slot content (the parent
   *                        wraps the group in `<SortableTreeGroup>` and passes
   *                        the handle to the root row here).
   *  - `DisabledGrouped` — render a greyed handle with an explanatory tooltip.
   *  - `Hidden`          — column sort is active; show no rank slot.
   *  - undefined         — caller is not a stack-rank surface; no slot.
   * Children of a tree group should always receive `undefined` so the slot
   * stays consistent across the root + children grid.
   */
  rankInteractionMode?: RankInteractionMode;
  /**
   * Element rendered into the rank slot when `rankInteractionMode === Enabled`.
   * Supplied by `<SortableTreeGroup>` and wires `@dnd-kit` listeners /
   * attributes to the grip-vertical button.
   */
  dragHandle?: React.ReactNode;
};

export function DocumentRow({
  item,
  visibleColumns,
  showCheckbox = false,
  isSelected = false,
  onSelectionChange,
  onMoreMenu,
  moreMenuContent,
  isExpanded,
  onToggleExpand,
  indentDepth = 0,
  editHandlers,
  parentTitle,
  parentHref,
  reserveChevronSlot = false,
  reserveRankSlot = false,
  selectMode,
  showBottomBorder = true,
  rankInteractionMode,
  dragHandle,
}: DocumentRowProps) {
  const params = useRouteParams();
  const buildOrgPath = useOrgPath();
  // Empty string (param absent or not a single string) falls through to the
  // row's own team id in computeHref().
  const activeTeamId = getStringRouteParam(params, "teamId") || undefined;

  const rankSlot = buildRankSlot(
    rankInteractionMode,
    dragHandle,
    reserveRankSlot
  );
  const gridTemplateColumns = getDocumentRowGridTemplateColumns(
    visibleColumns.length
  );

  function computeHref(): string | null {
    // Project rows are not artifacts: their route needs the team context, so
    // they stay outside the row-type registry.
    if (item.kind === "project") {
      const teamId = activeTeamId ?? item.data.teams[0]?.id;
      return teamId
        ? buildOrgPath(`/teams/${teamId}/projects/${item.data.id}`)
        : null;
    }
    const route = getRowTypeConfig(item)?.route ?? null;
    return route ? buildOrgPath(route) : null;
  }

  const href = computeHref();

  return (
    <RowEditContext.Provider
      value={{ ...(editHandlers ?? {}), parentHref, parentTitle }}
    >
      <div
        className={`group/row relative grid min-h-11 min-w-fit ${isSelected ? "bg-accent/40 hover:bg-accent/60" : "bg-background hover:bg-muted/40"}`}
        style={{ gridTemplateColumns }}
      >
        {showBottomBorder && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 border-b" />
        )}
        <div>
          <NameCell
            href={href}
            indentDepth={indentDepth}
            isExpanded={isExpanded}
            isSelected={isSelected}
            item={item}
            onSelectionChange={onSelectionChange}
            onToggleExpand={onToggleExpand}
            rankSlot={rankSlot}
            reserveChevronSlot={reserveChevronSlot}
            selectMode={selectMode}
            showCheckbox={showCheckbox}
          />
        </div>

        {visibleColumns.map((column) => {
          const CellRenderer = CELL_RENDERERS[column];
          return (
            <div key={column}>
              <CellRenderer item={item} />
            </div>
          );
        })}

        {/* More menu */}
        <div>
          <div className="flex h-full min-h-11 items-center border-l px-1 py-2">
            {item.kind !== "project" && (
              <FavoriteButton artifactId={item.data.id} size="sm" />
            )}
            {moreMenuContent ?? (
              <button
                aria-label="More actions"
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onMoreMenu?.(item, e.currentTarget);
                }}
                type="button"
              >
                <EllipsisIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </RowEditContext.Provider>
  );
}

export function getDocumentRowGridTemplateColumns(
  visibleColumnCount: number
): string {
  return [
    "minmax(350px, 1fr)",
    ...Array.from({ length: visibleColumnCount }, () => "124px"),
    "88px",
  ].join(" ");
}
