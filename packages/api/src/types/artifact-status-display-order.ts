import { DocumentStatus, IssueStatus } from "./document.ts";

/**
 * Combined display order for the mixed documents table (Documents + Features in
 * one list). Blends both lifecycles: not-started → active → review → blocked →
 * terminal. `IN_REVIEW` is shared by both vocabularies and appears once.
 *
 * Here rather than in `@repo/app` since ISS-10472: the assigned tree WILL order
 * and section its root groups in SQL, so `apps/api` will need this rank, and a
 * second copy on the server would section one population and count another.
 */
export const STATUS_DISPLAY_ORDER: string[] = [
  DocumentStatus.Draft,
  IssueStatus.Triage,
  IssueStatus.Backlog,
  IssueStatus.Todo,
  IssueStatus.InProgress,
  DocumentStatus.InReview,
  DocumentStatus.ChangesRequested,
  IssueStatus.Blocked,
  DocumentStatus.Approved,
  DocumentStatus.Executed,
  IssueStatus.Done,
  IssueStatus.Canceled,
  DocumentStatus.Obsolete,
];

const STATUS_DISPLAY_RANKS = new Map<string, number>(
  STATUS_DISPLAY_ORDER.map((status, index) => [status, index])
);

/**
 * Where a status belongs in {@link STATUS_DISPLAY_ORDER}. Anything the order
 * does not name — and a row carrying no status at all — ranks after every known
 * status.
 *
 * ISS-9669: this is the ONE derivation both the documents table's status sort
 * (`compareStatusValues`) and its status GROUPING (`compareStatusSections`)
 * read. They used to answer separately and disagree: the sort used
 * `STATUS_DISPLAY_ORDER.length` for a miss so an unknown status sorted last,
 * while the grouper used `indexOf`, whose `-1` put the identical rows in a
 * header section above `DRAFT`. Sorting the Status column pushed those rows to
 * the bottom and grouping by Status hoisted them to the top — one table, two
 * answers about the same row. `Artifact.status` is a freeform column carrying
 * two vocabularies (`statusOptionsForSubtype` picks which applies), and branch
 * and session rows enter this table with statuses in NEITHER, so unknown is a
 * routine input here, not a corrupt one.
 */
export function statusDisplayRank(status: string | null | undefined): number {
  if (!status) {
    return STATUS_DISPLAY_ORDER.length;
  }
  return STATUS_DISPLAY_RANKS.get(status) ?? STATUS_DISPLAY_ORDER.length;
}
