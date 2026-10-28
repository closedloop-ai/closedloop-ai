import {
  BranchDetailTabParam,
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import {
  APPROVED_BRANCH_COLUMN_SPECS,
  type ApprovedBranchColumnSpec,
  approvedBranchRepositoryLabels,
  renderApprovedBranchCell,
} from "@repo/app/branches/components/approved-branches-grid-adapter";
import type {
  BranchRow,
  BranchRowSession,
} from "@repo/app/branches/lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import { LIVE_ORG_SLUG } from "../surfaces-v2/live-route";

// The Branches list's branch-specific column cells (ISS-12117 §2), each
// rendered by the production cell renderer the list's grid uses
// (`renderApprovedBranchCell`), at its column's own track width and under its
// own header label. One line per state the cell can be in. The state names on
// the left are Storybook annotations, not product copy.
// The finished list is Surfaces/Artifacts/Branches/Branches List.

type BranchCellExample = {
  /** The state this line shows. A Storybook annotation, not product copy. */
  state: string;
  row: BranchRow;
};

const [BASE_ROW] = BRANCH_SAMPLE_ROWS;
if (!BASE_ROW) {
  throw new Error("BRANCH_SAMPLE_ROWS is empty");
}

/** A sample Branches row with the fields a cell example varies. */
export function branchCellRow(
  id: string,
  overrides: Partial<BranchRow> = {}
): BranchRow {
  return { ...BASE_ROW, id, branchName: `story/${id}`, ...overrides };
}

// The two hrefs the web Branches page hands the surface, built the way it
// builds them (`apps/app/.../branches/page.tsx`): the notification-route SSOT,
// prefixed with the org slug.

/** The Branch Sessions tab a linked-session count opens. */
function storySessionsHref(row: BranchRow): string {
  return `/${LIVE_ORG_SLUG}${getNotificationEntityPath({
    kind: NotificationEntityKind.Branch,
    branchId: row.id,
    tab: BranchDetailTabParam.SessionsTimeline,
  })}`;
}

/** The Session detail a linked-session chip opens. */
function storySessionHref(session: BranchRowSession): string {
  return `/${LIVE_ORG_SLUG}${getNotificationEntityPath({
    kind: NotificationEntityKind.Session,
    sessionId: session.navigableRef,
  })}`;
}

function columnSpec(columnId: string): ApprovedBranchColumnSpec {
  const spec = APPROVED_BRANCH_COLUMN_SPECS.find(
    (candidate) => candidate.id === columnId
  );
  if (!spec) {
    throw new Error(`the Branches list has no "${columnId}" column`);
  }
  return spec;
}

/** One column's cell in each of its states, under the column's header. */
export function BranchCellExamples({
  columnId,
  examples,
  chipsSupportedBySurface = false,
}: Readonly<{
  columnId: string;
  examples: readonly BranchCellExample[];
  chipsSupportedBySurface?: boolean;
}>) {
  const spec = columnSpec(columnId);
  const repositoryLabels = approvedBranchRepositoryLabels(
    examples.map((example) => example.row)
  );
  return (
    <div className="inline-grid grid-cols-[12rem_auto] overflow-hidden rounded-md border text-sm">
      <div className="border-b bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
        State
      </div>
      <div
        className="border-b bg-muted/40 px-3 py-2 font-medium text-muted-foreground text-xs"
        data-testid="branch-cell-header"
        style={{ width: spec.width }}
      >
        {spec.label}
      </div>
      {examples.map((example) => (
        <div className="contents" key={example.row.id}>
          <div className="flex items-center border-b px-3 py-2 text-muted-foreground text-xs">
            {example.state}
          </div>
          <div
            className="flex min-h-11 min-w-0 items-center border-b px-3 py-2"
            data-testid={`branch-cell-${example.row.id}`}
            style={{ width: spec.width }}
          >
            {renderApprovedBranchCell(
              columnId,
              example.row,
              repositoryLabels,
              storySessionsHref,
              true,
              {
                chipsSupportedBySurface,
                getSessionHref: storySessionHref,
              }
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
