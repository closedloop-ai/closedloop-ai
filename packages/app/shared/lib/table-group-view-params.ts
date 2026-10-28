import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingLevel,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import {
  readTableCollapsedGroupParams,
  type TableCollapsedGroups,
  writeTableCollapsedGroupParams,
} from "./table-collapsed-groups";
import { TABLE_GROUPING_LEVEL_SCHEMA } from "./table-grouping-serialization";

/** One encoded field:order value per level; simple legacy field values stay unchanged. */
export const TABLE_GROUP_PARAM = "group" as const;
/** One `true`/`false` per level, written only by surfaces that link empty-group visibility. */
export const TABLE_GROUP_EMPTY_PARAM = "groupEmpty" as const;
const GROUP_LEVEL_ORDER_SEPARATOR = ":";
const GROUP_ORDER_SCHEMA = TABLE_GROUPING_LEVEL_SCHEMA.shape.order;

/** Linked grouping is atomic: reject the whole axis when a level cannot be honoured. */
export function readTableGroupViewParams(
  params: Pick<URLSearchParams, "getAll">,
  isGroupableField: (field: string) => boolean,
  includeEmptyGroups = false
): TableGroupViewParams | null {
  const levels = params.getAll(TABLE_GROUP_PARAM);
  if (levels.length === 0 || levels.length > 2) {
    return null;
  }
  const emptyLevels = includeEmptyGroups
    ? params.getAll(TABLE_GROUP_EMPTY_PARAM)
    : [];
  const primary = parseGroupLevel(levels[0], isGroupableField, emptyLevels[0]);
  const secondary =
    levels[1] === undefined
      ? EMPTY_TABLE_GROUPING.secondary
      : parseGroupLevel(levels[1], isGroupableField, emptyLevels[1]);
  if (
    primary === null ||
    secondary === null ||
    primary.fieldId === secondary.fieldId
  ) {
    return null;
  }
  const grouping = { primary, secondary };
  return {
    grouping,
    collapsedGroups: readTableCollapsedGroupParams(params, grouping),
  };
}

/** Write grouping and its active-axis collapse together, preserving unrelated parameters. */
export function writeTableGroupViewParams(
  params: URLSearchParams,
  grouping: TableGroupingState,
  collapsedGroups: Readonly<TableCollapsedGroups>,
  includeEmptyGroups = false
): void {
  params.delete(TABLE_GROUP_PARAM);
  if (includeEmptyGroups) {
    params.delete(TABLE_GROUP_EMPTY_PARAM);
  }
  writeTableCollapsedGroupParams(params, grouping, collapsedGroups);
  if (grouping.primary.fieldId === null) {
    return;
  }
  const levels = [grouping.primary, grouping.secondary].filter(
    (level) => level.fieldId !== null
  );
  const carriesEmpty =
    includeEmptyGroups && levels.some((level) => level.showEmptyGroups);
  for (const level of levels) {
    params.append(
      TABLE_GROUP_PARAM,
      `${encodeURIComponent(level.fieldId ?? "")}${GROUP_LEVEL_ORDER_SEPARATOR}${level.order}`
    );
    if (carriesEmpty) {
      params.append(TABLE_GROUP_EMPTY_PARAM, String(level.showEmptyGroups));
    }
  }
}

/** The linked axis and its normalized, bounded collapsed keys. */
export type TableGroupViewParams = {
  grouping: TableGroupingState;
  collapsedGroups: TableCollapsedGroups;
};

function parseGroupLevel(
  raw: string | undefined,
  isGroupableField: (field: string) => boolean,
  showEmpty: string | undefined
): TableGroupingLevel | null {
  if (raw === undefined) {
    return null;
  }
  const [encodedField, order = TableGroupOrder.Custom, ...rest] = raw.split(
    GROUP_LEVEL_ORDER_SEPARATOR
  );
  let fieldId: string;
  try {
    fieldId = decodeURIComponent(encodedField);
  } catch {
    return null;
  }
  const parsedOrder = GROUP_ORDER_SCHEMA.safeParse(order);
  if (rest.length > 0 || !isGroupableField(fieldId) || !parsedOrder.success) {
    return null;
  }
  return {
    fieldId,
    order: parsedOrder.data,
    showEmptyGroups: showEmpty === "true",
  };
}
