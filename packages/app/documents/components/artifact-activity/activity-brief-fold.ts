import {
  activityChangedFieldKey,
  fieldLabel,
} from "@repo/app/documents/components/feed-sidebar/sources/activity-snapshot";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "./activity-timeline";

/**
 * ISS-12579 (DI-09): the Activity brief on an issue's Artifact tab, folded
 * from the issue's history (rulings on ISS-12570, Nerys 2026-10-19):
 *
 * - the first `edge` rows (who created the issue, its first events) and the
 *   last `edge` rows (what happened last) always show;
 * - everything between folds into one row that counts and names what it hides
 *   ("Show 10 events: changed project, status, assignee") and opens the
 *   Activity tab, never an inline expand;
 * - comments in the middle fold with the events (Nerys, 2026-10-21, ISS-12576):
 *   they live in the comments rail, so the brief does not repeat them; they
 *   are counted with the events that name no field;
 * - a fold of a single event shows that event instead, since folding it saves
 *   nothing.
 *
 * Branch and pull request state is not a row here: the linked work card above
 * the brief (DI-10) shows it live.
 */

export const ActivityBriefItemKind = {
  Row: "row",
  Fold: "fold",
} as const;

export type ActivityBriefItem =
  | { kind: typeof ActivityBriefItemKind.Row; row: ActivityTimelineRow }
  | {
      kind: typeof ActivityBriefItemKind.Fold;
      /** A stable key: the first folded row's id. */
      key: string;
      count: number;
      /** What the folded events changed, first-seen order, no repeats. */
      changed: readonly string[];
      /**
       * Folded rows that name no field (a comment, a projection such as a new
       * version, or a change whose snapshot was never written). Counted,
       * never guessed.
       */
      unnamed: number;
    };

/** How many rows the brief keeps at each end by default. */
export const ACTIVITY_BRIEF_EDGE = 2;

/**
 * The fold's sentence, e.g. "Show 10 events: changed project, status". Events
 * that name no field are counted after the named ones ("…, and 3 more"), so
 * the sentence never reads as if every event were one of the named changes.
 */
export function activityBriefFoldLabel(
  item: Extract<ActivityBriefItem, { kind: typeof ActivityBriefItemKind.Fold }>
): string {
  const head = `Show ${item.count} events`;
  if (item.changed.length === 0) {
    return head;
  }
  const named = `${head}: changed ${item.changed.join(", ")}`;
  return item.unnamed > 0 ? `${named}, and ${item.unnamed} more` : named;
}

/**
 * Folds rows given in reading order (oldest first) into the brief's items.
 */
export function foldActivityBrief(
  rows: readonly ActivityTimelineRow[],
  edge: number = ACTIVITY_BRIEF_EDGE
): ActivityBriefItem[] {
  if (rows.length <= 2 * edge) {
    return rows.map(asRow);
  }
  return [
    ...rows.slice(0, edge).map(asRow),
    ...foldRun(rows.slice(edge, rows.length - edge)),
    ...rows.slice(rows.length - edge).map(asRow),
  ];
}

function asRow(row: ActivityTimelineRow): ActivityBriefItem {
  return { kind: ActivityBriefItemKind.Row, row };
}

function foldRun(run: readonly ActivityTimelineRow[]): ActivityBriefItem[] {
  if (run.length < 2) {
    return run.map(asRow);
  }
  const labels = run.map(changedLabel);
  const changed = [...new Set(labels.filter((label) => label !== null))];
  return [
    {
      kind: ActivityBriefItemKind.Fold,
      key: rowKey(run[0]),
      count: run.length,
      changed,
      unnamed: labels.filter((label) => label === null).length,
    },
  ];
}

/**
 * What one folded event changed, in the feed's own field words
 * (`fieldLabel`). An assignment whose role was recorded names it ("assignee",
 * "owner"); one without a role reads "assignment", which claims no role.
 */
function changedLabel(row: ActivityTimelineRow): string | null {
  if (row.kind !== ActivityTimelineRowKind.Activity) {
    return null;
  }
  const key = activityChangedFieldKey(row.item.event);
  return key === null ? null : fieldLabel(key);
}

function rowKey(row: ActivityTimelineRow | undefined): string {
  if (row === undefined) {
    return "fold";
  }
  return row.kind === ActivityTimelineRowKind.Activity ? row.item.id : row.id;
}
