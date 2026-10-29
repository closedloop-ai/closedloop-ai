/**
 * ISS-12454, marisolashgrove review: filing one row from the grid must not throw
 * away the rest of a bulk selection.
 *
 * A `CommandItem` renders as `div role=option`, which
 * `INTERACTIVE_CELL_CONTENT_SELECTOR` does not list, and the picker's content is
 * portaled — but React bubbles the synthetic click out of the portal to the
 * row's own `onClick`, so `isInteractiveRowClickTarget` answered false and
 * `resolveGridRowSelection` replaced the whole selection with this one row. The
 * trigger was never the problem; it is a `button`.
 *
 * Driven through the REAL seam and the REAL surface, which is the only shape
 * that can see this: the sibling write suite mounts `SyncedSessionsTable`, which
 * has no selection model, and a stand-in `renderProjects` would not contain the
 * popover whose markup is the defect.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { SESSIONS_PROJECTS_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  createAgentSessionListItemFixture,
  createSessionTableRowFixture,
} from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";
import { useSessionLinkedEntitySeams } from "../use-session-linked-entity-seams";

const ROW_ONE_ID = "11111111-1111-4111-8111-111111111111";
const ROW_TWO_ID = "44444444-4444-4444-8444-444444444444";
const ROW_ONE_NAME = "Selected row one";
const ROW_TWO_NAME = "Selected row two";
const PROJECT_A = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Platform Core",
  slug: "PRO-1",
};
const PROJECT_B = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Developer Tooling",
  slug: "PRO-2",
};
/** Comfortably above `CARD_FALLBACK_BREAKPOINT` (768), so the grid path renders. */
const GRID_CONTAINER_WIDTH_PX = 1440;

const VIEW: SessionsListViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  search: "",
  sortBy: null,
  sortDir: "desc",
  visibleColumnIds: new Set([SESSIONS_PROJECTS_COLUMN_ID]),
};

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({ id: ROW_ONE_ID, name: ROW_ONE_NAME }),
  createSessionTableRowFixture({ id: ROW_TWO_ID, name: ROW_TWO_NAME }),
];

/** Both rows filed into the same project, which is what the seam reads. */
const ITEM_BY_ID = new Map(
  ROWS.map((row) => [
    row.id,
    createAgentSessionListItemFixture({
      id: row.id,
      name: row.name,
      project: PROJECT_A,
    }),
  ])
);

/** A host capability, so the list keeps its selection model. */
const FAVORITES = {
  favoriteIds: new Set<string>(),
  onChange: () => {
    // not under test
  },
  onToggleFavorite: () => {
    // not under test
  },
};

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  cleanup();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("Sessions list — filing one row out of a bulk selection (ISS-12454)", () => {
  it("keeps every selected row selected when a project is picked", async () => {
    const selections: ReadonlySet<string>[] = [];
    const moves: unknown[] = [];
    renderSelectedPair(selections, moves);

    const user = userEvent.setup();
    await user.click(projectTrigger(ROW_ONE_NAME));
    await user.click(
      await screen.findByRole("option", {
        name: new RegExp(`^${PROJECT_B.name}`),
      })
    );

    // The pick LANDED. Without this the case below passes against a popover
    // that never opened, which is the one way "the selection did not move"
    // is true for the wrong reason.
    expect(moves).toHaveLength(1);
    // And moved no selection AT ALL — every set the controller was handed,
    // because an intact selection is one the surface never reported a change to.
    // Before the fix this held `[{ROW_ONE_ID}]`: the plain click replaced the
    // pair with the row that was filed.
    expect(selections.map((ids) => [...ids].sort())).toEqual([]);
  });
});

/** The owning-project picker's trigger inside one named row. */
function projectTrigger(rowName: string): HTMLElement {
  const row = screen.getByText(rowName).closest(".group.grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Could not find the sessions row for ${rowName}`);
  }
  const trigger = row.querySelector<HTMLElement>(
    `[data-column-id="${SESSIONS_PROJECTS_COLUMN_ID}"] button`
  );
  if (trigger === null) {
    throw new Error("The owning-project cell offers no control");
  }
  return trigger;
}

/**
 * The surface with BOTH rows already selected and a live selection controller,
 * recording every set it is handed.
 */
function renderSelectedPair(
  selections: ReadonlySet<string>[],
  moves: unknown[]
): void {
  restoreContainerWidth = stubContainerWidthPx(GRID_CONTAINER_WIDTH_PX);
  render(
    <AppCoreStoryProviders
      apiRoutes={[
        {
          method: "GET" as const,
          path: "/projects",
          respond: () => [PROJECT_A, PROJECT_B],
        },
        {
          method: "POST" as const,
          path: "/artifact-links/batch-move",
          respond: (context: FixtureRequestContext) => {
            moves.push(context.body);
            return {
              movedArtifacts: [{ id: ROW_ONE_ID, type: ArtifactType.Session }],
            };
          },
        },
      ]}
    >
      <SelectedPairSurface onSelectionChange={selections} />
    </AppCoreStoryProviders>
  );
}

function SelectedPairSurface({
  onSelectionChange,
}: Readonly<{ onSelectionChange: ReadonlySet<string>[] }>) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set([ROW_ONE_ID, ROW_TWO_ID])
  );
  const { renderProjects } = useSessionLinkedEntitySeams({
    itemById: ITEM_BY_ID,
    rows: ROWS,
    showLinkedEntityColumns: true,
  });
  return (
    <SessionsListSurfaceV2
      controlledView={{
        onChange: () => {
          // not under test
        },
        totalRows: ROWS.length,
        value: VIEW,
      }}
      favorites={FAVORITES}
      renderProjects={renderProjects}
      rows={ROWS}
      selection={{
        onChange: (next) => {
          onSelectionChange.push(next);
          setSelectedIds(next);
        },
        selectedIds,
      }}
      usage={undefined}
    />
  );
}
