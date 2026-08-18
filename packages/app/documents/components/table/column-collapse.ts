import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { DEFAULT_PRIORITY } from "@repo/app/shared/lib/priority-constants";

/**
 * Column decluttering for the artifact/My-Issues table (FEA-3945 / FEA-3946).
 *
 * Two independent rule families drop columns that convey no information for the
 * currently-visible rows, so the Name column reclaims their width:
 *
 *  - **Empty** (FEA-3946): a column that is empty on every visible row (Parent,
 *    all-default Priority) reserves width for nothing. Dropped entirely, on
 *    every surface — an empty column is noise regardless of view.
 *  - **Constant** (FEA-3945): a column whose value is identical on every
 *    visible row is redundant *for a single-scope "My Issues" view* — every
 *    row is the same Assignee and (when scoped to one project) the same
 *    Project, exactly what Linear's "My Issues" hides. This is **opt-in per
 *    caller** (`collapseConstantColumns`): a general artifacts table keeps its
 *    Assignee/Project columns even when they happen to be constant, because
 *    they are inline-edit controls the column menu still advertises as enabled.
 *
 * The rule set is deliberately conservative: it only collapses columns whose
 * value can be read cheaply and deterministically from the row item plus the
 * per-page context (parent titles) the caller already has. A column with no
 * extractor here is always kept, so unknown/new columns never silently
 * disappear.
 */

/**
 * Sentinel for "no value" — distinct from any real key string so an all-empty
 * column is detected as empty rather than as a constant empty-string value.
 */
const EMPTY = Symbol("empty");
type ColumnKey = string | typeof EMPTY;

export type ColumnCollapseContext = {
  /** Whether the row (by id) has a parent link on this page. */
  hasParent: (id: string) => boolean;
  /**
   * Opt in to the constant-column rule (hide a constant Assignee/Project),
   * appropriate only for single-scope "My Issues" views. Off by default so a
   * general artifacts table never drops an inline-edit column the column menu
   * still lists as enabled. FEA-3945 / reviewer feedback.
   */
  collapseConstantColumns?: boolean;
};

/**
 * Per-column value extractor. Returns `EMPTY` when the column renders nothing
 * for this row, or a stable string key identifying the rendered value so two
 * rows with the same value collapse together. Only document/project rows carry
 * these fields; branch/session rows return `EMPTY` (they render read-only
 * dashes for the editable columns) so a page of only branches collapses them.
 */
type ColumnExtractor = (
  item: DocumentRowItem,
  context: ColumnCollapseContext
) => ColumnKey;

function assigneeKey(item: DocumentRowItem): ColumnKey {
  if (item.kind === "project" || getRowTypeConfig(item)?.editable === false) {
    return EMPTY;
  }
  return item.data.assignee?.id ?? EMPTY;
}

function projectKey(item: DocumentRowItem): ColumnKey {
  if (item.kind === "project") {
    return item.data.id;
  }
  if (item.kind === "document" && item.data.project) {
    return item.data.project.id;
  }
  return EMPTY;
}

function priorityKey(item: DocumentRowItem): ColumnKey {
  if (item.kind === "project" || getRowTypeConfig(item)?.editable === false) {
    return EMPTY;
  }
  // The default priority conveys nothing (every artifact starts at Medium),
  // so treat it as empty — a page of all-default priorities collapses.
  const priority = item.data.priority ?? null;
  return priority && priority !== DEFAULT_PRIORITY ? priority : EMPTY;
}

function parentKey(
  item: DocumentRowItem,
  context: ColumnCollapseContext
): ColumnKey {
  return context.hasParent(item.data.id) ? item.data.id : EMPTY;
}

/**
 * Columns whose collapse rule is "empty on every row" (progressive
 * disclosure). These have no meaningful constant state to preserve.
 */
const EMPTY_COLLAPSE_EXTRACTORS: Partial<
  Record<DocumentColumn, ColumnExtractor>
> = {
  [DocumentColumn.Parent]: parentKey,
  [DocumentColumn.Priority]: priorityKey,
};

/**
 * Columns whose collapse rule is "constant across every row OR empty on every
 * row". Hiding a constant Assignee/Project matches single-scope views like
 * Linear's "My Issues".
 */
const CONSTANT_COLLAPSE_EXTRACTORS: Partial<
  Record<DocumentColumn, ColumnExtractor>
> = {
  [DocumentColumn.Assignee]: assigneeKey,
  [DocumentColumn.Project]: projectKey,
};

function isEmptyForAllRows(
  extractor: ColumnExtractor,
  items: DocumentRowItem[],
  context: ColumnCollapseContext
): boolean {
  return items.every((item) => extractor(item, context) === EMPTY);
}

function isConstantAcrossRows(
  extractor: ColumnExtractor,
  items: DocumentRowItem[],
  context: ColumnCollapseContext
): boolean {
  const first = extractor(items[0], context);
  return items.every((item) => extractor(item, context) === first);
}

function shouldCollapse(
  column: DocumentColumn,
  items: DocumentRowItem[],
  context: ColumnCollapseContext
): boolean {
  // Empty rule: applies on every surface and at any row count — a column that
  // is empty on every visible row is noise even for a single filtered row.
  const emptyExtractor = EMPTY_COLLAPSE_EXTRACTORS[column];
  if (emptyExtractor && isEmptyForAllRows(emptyExtractor, items, context)) {
    return true;
  }
  // Constant rule: opt-in (single-scope "My Issues" views) AND needs at least
  // two rows — one row is trivially "constant", so a single filtered Medium
  // item must not silently drop its Assignee/Project column.
  const constantExtractor = CONSTANT_COLLAPSE_EXTRACTORS[column];
  if (
    context.collapseConstantColumns &&
    items.length >= 2 &&
    constantExtractor &&
    (isEmptyForAllRows(constantExtractor, items, context) ||
      isConstantAcrossRows(constantExtractor, items, context))
  ) {
    return true;
  }
  return false;
}

/**
 * Drop columns that convey no information across the given visible rows. Empty
 * columns collapse even for a single row; the constant Assignee/Project rule
 * needs two rows (a single row is trivially "constant") and the caller's
 * `collapseConstantColumns` opt-in. With no rows there is nothing to declutter.
 */
export function collapseUninformativeColumns(
  columns: DocumentColumn[],
  items: DocumentRowItem[],
  context: ColumnCollapseContext
): DocumentColumn[] {
  if (items.length === 0) {
    return columns;
  }
  return columns.filter((column) => !shouldCollapse(column, items, context));
}
