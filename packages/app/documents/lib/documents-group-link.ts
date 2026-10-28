import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  cleanCollapsedGroupKeys,
  type TableCollapsedGroups,
  tableGroupingAxisKey,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  readTableGroupViewParams,
  type TableGroupViewParams,
} from "@repo/app/shared/lib/table-group-view-params";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";

/**
 * PRD-720 AC3: the Documents grouping as the shared table grouping, so its link
 * and its per-axis collapse go through the same codec Branches and Sessions use.
 *
 * Documents has one grouping level and no order control: band order is the
 * section policy (`compareSections`), so every level is written `custom`.
 */
export function documentsGroupingState(
  groupBy: GroupByMode
): TableGroupingState {
  if (groupBy === GroupByMode.None) {
    return EMPTY_TABLE_GROUPING;
  }
  return {
    ...EMPTY_TABLE_GROUPING,
    primary: {
      fieldId: groupBy,
      order: TableGroupOrder.Custom,
      showEmptyGroups: false,
    },
  };
}

/**
 * The grouping and collapsed bands a Documents link states, or `null` when it
 * states none. Only the primary level is honoured: a second level names a
 * grouping this list cannot render, so the whole link is rejected rather than
 * half applied, and the reader's own stored view stands. Any stated order is
 * accepted and ignored, which keeps a link that spells `group=status` (no order)
 * working.
 */
export function readDocumentsGroupLink(
  params: Pick<URLSearchParams, "getAll">
): DocumentsGroupLink | null {
  const linked = readTableGroupViewParams(params, isDocumentsGroupField);
  if (linked === null || linked.grouping.secondary.fieldId !== null) {
    return null;
  }
  const groupBy = linked.grouping.primary.fieldId;
  if (groupBy === null || !isDocumentsGroupField(groupBy)) {
    return null;
  }
  // The collapse axis names fields, not orders, so the keys read under the
  // stated order belong to the same axis as the normalized grouping.
  return {
    collapsedGroups: linked.collapsedGroups,
    groupBy,
    grouping: documentsGroupingState(groupBy),
  };
}

/**
 * The suffix of the flat band-collapse record `DocumentsView` keeps under its
 * expansion key: a list of collapsed band keys with no grouping axis.
 */
export const LEGACY_GROUP_SECTIONS_KEY_SUFFIX = "-group-sections";

/**
 * A flat collapse record carried into the per-axis shape. The flat record
 * applied each closed key under whatever grouping was shown, so the carried
 * record states the same keys under every Documents axis: every band a reader
 * had closed stays closed, under the grouping they closed it in or any other.
 */
export function collapsedGroupsFromLegacySections(
  keys: readonly string[]
): TableCollapsedGroups {
  const clean = cleanCollapsedGroupKeys(keys);
  if (clean.length === 0) {
    return {};
  }
  return Object.fromEntries(
    DOCUMENTS_GROUP_MODES.flatMap((mode) => {
      const axis = tableGroupingAxisKey(documentsGroupingState(mode));
      return axis === null ? [] : [[axis, clean]];
    })
  );
}

/** A Documents link, with its grouping in both vocabularies. */
export type DocumentsGroupLink = TableGroupViewParams & {
  groupBy: Exclude<GroupByMode, typeof GroupByMode.None>;
};

function isDocumentsGroupField(
  field: string
): field is Exclude<GroupByMode, typeof GroupByMode.None> {
  return DOCUMENTS_GROUP_FIELDS.has(field);
}

type DocumentsGroupField = Exclude<GroupByMode, typeof GroupByMode.None>;

const DOCUMENTS_GROUP_MODES: readonly DocumentsGroupField[] = Object.values(
  GroupByMode
).filter((mode): mode is DocumentsGroupField => mode !== GroupByMode.None);

const DOCUMENTS_GROUP_FIELDS: ReadonlySet<string> = new Set(
  DOCUMENTS_GROUP_MODES
);
