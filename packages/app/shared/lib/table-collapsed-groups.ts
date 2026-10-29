import type { TableGroupingState } from "@repo/design-system/components/ui/table-toolbar-model";
import { collectCollapsedGroupKeys } from "@repo/design-system/lib/grid-table-v2-rows";
import type {
  GridTableV2Group,
  GridTableV2Props,
} from "@repo/design-system/lib/grid-table-v2-types";
import { z } from "zod";

/**
 * ISS-9582: which table bands a reader collapsed, per grouping axis.
 *
 * Keyed by axis, never one flat list. A band key only means something under the
 * axis that cut it: a repository band is `owner/repo`, and the grid composes a
 * subgroup's key as `group/subgroup` (`buildSubgroupKey`), so the same string
 * names a repository under one axis and an author's subgroup under another. A
 * flat set would collapse the wrong band the moment the reader switched axes.
 *
 * The keys are the composed keys the `groupCollapse` port hands the host, not
 * band labels, so a relabelled band keeps its state.
 */
export type TableCollapsedGroups = Record<string, string[]>;

export const EMPTY_TABLE_COLLAPSED_GROUPS: TableCollapsedGroups = {};

/**
 * Per-axis ceiling on collapsed band keys, and on how many axes one record
 * carries. It bounds a stored view and a link a hostile or corrupt source wrote.
 * Its own constant rather than the carried-column-id cap it matches in value:
 * band keys come from repository and author identities, which have no column
 * catalog behind them, so the two bounds must be free to move apart.
 */
export const MAX_COLLAPSED_GROUP_KEYS_PER_AXIS = 64;

const AXIS_SEPARATOR = "|";

/** The axis a collapse set belongs to, or `null` when nothing is grouped. */
export function tableGroupingAxisKey(
  grouping: TableGroupingState
): string | null {
  const primary = grouping.primary.fieldId;
  if (primary === null) {
    return null;
  }
  return `${primary}${AXIS_SEPARATOR}${grouping.secondary.fieldId ?? ""}`;
}

/**
 * Persisted collapse state, cleaned rather than validated whole: a non-object
 * degrades to `{}`, an axis whose value is not an array is dropped, non-string
 * entries are dropped, duplicates collapse, and both levels are capped. An
 * empty axis is dropped, so "nothing collapsed" has one spelling.
 */
export const PERSISTED_COLLAPSED_GROUPS_SCHEMA = z
  .preprocess(cleanCollapsedGroups, z.record(z.string(), z.array(z.string())))
  .catch({})
  .default({});

/**
 * Clean one untrusted key list: strings only, deduplicated, capped. Keys are
 * kept newest-last, so the cap keeps the most recent ones — the same end
 * `nextCollapsedGroups` evicts from.
 */
export function cleanCollapsedGroupKeys(value: unknown): string[] {
  const list = UNKNOWN_LIST_SCHEMA.safeParse(value);
  if (!list.success) {
    return [];
  }
  const keys = new Set<string>();
  for (const entry of list.data) {
    const key = STRING_SCHEMA.safeParse(entry);
    if (key.success) {
      // Re-inserted, so a repeated key sits at its NEWEST position and the cap
      // below keeps it.
      keys.delete(key.data);
      keys.add(key.data);
    }
  }
  return [...keys].slice(-MAX_COLLAPSED_GROUP_KEYS_PER_AXIS);
}

/**
 * Whether two collapse records describe the same view. Each axis is a SET — the
 * order a reader collapsed bands in is not part of the view — and an empty axis
 * equals an absent one.
 */
export function collapsedGroupsEqual(
  a: Readonly<TableCollapsedGroups>,
  b: Readonly<TableCollapsedGroups>
): boolean {
  const axes = new Set([...nonEmptyAxes(a), ...nonEmptyAxes(b)]);
  for (const axis of axes) {
    const left = new Set(a[axis] ?? []);
    const right = new Set(b[axis] ?? []);
    if (left.size !== right.size) {
      return false;
    }
    for (const key of left) {
      if (!right.has(key)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Every key the grid can ask about for these bands: each band's key and each
 * subgroup's composed key. The grid's own walk, asked to keep every key, so the
 * two cannot disagree about how a subgroup key is composed.
 */
export function renderedTableGroupKeys<T>(
  groups: readonly GridTableV2Group<T>[]
): Set<string> {
  return collectCollapsedGroupKeys(groups, () => true);
}

/** What the grid can see of the population when a band is toggled. */
export type RenderedTableBands = {
  /** Every key the grid can ask about on this page (`renderedTableGroupKeys`). */
  renderedKeys: ReadonlySet<string>;
  /**
   * The rendered rows are the whole corpus — served complete, not client-paged,
   * not narrowed by a filter or window — so no real band can be missing here.
   */
  isCompletePopulation: boolean;
};

/**
 * The record after one band is opened or closed under `axisKey`. Other axes are
 * untouched.
 *
 * A key that names no band is never written back WHERE THAT IS DECIDABLE. When
 * the rendered rows are the whole corpus, a key missing from the rendered bands
 * is a band that does not exist, so the axis is rebuilt from the rendered keys
 * and the unknown key is dropped. Anywhere else it is not decidable: bands are
 * cut from one page of a scope, and a key missing here may name a band on the
 * next page or one a filter hides. Dropping it would reopen that band when the
 * reader came back to it, so the gesture changes only the clicked key and
 * carries the rest. The cap then evicts the OLDEST keys, so the band just
 * closed always survives.
 */
export function nextCollapsedGroups(
  current: Readonly<TableCollapsedGroups>,
  axisKey: string,
  groupKey: string,
  collapsed: boolean,
  bands: RenderedTableBands
): TableCollapsedGroups {
  const carried = (current[axisKey] ?? []).filter(
    (key) =>
      key !== groupKey &&
      (!bands.isCompletePopulation || bands.renderedKeys.has(key))
  );
  const keys = collapsed ? [...carried, groupKey] : carried;
  const capped = keys.slice(-MAX_COLLAPSED_GROUP_KEYS_PER_AXIS);
  const others = Object.entries(current).filter(([axis]) => axis !== axisKey);
  return Object.fromEntries(
    capped.length === 0 ? others : [...others, [axisKey, capped]]
  );
}

/**
 * The `groupCollapse` port for a grouped grid, or `undefined` when the host
 * holds no collapse state (a story, a unit mount) or nothing is grouped — the
 * grid then owns collapse itself, as it always has.
 */
export function tableGroupCollapsePort<T>(input: {
  collapsedGroups: Readonly<TableCollapsedGroups> | undefined;
  grouping: TableGroupingState;
  groups: readonly GridTableV2Group<T>[] | undefined;
  isCompletePopulation: boolean;
  onCollapsedGroupsChange: ((next: TableCollapsedGroups) => void) | undefined;
}): GridTableV2Props<T>["groupCollapse"] {
  const { collapsedGroups, groups, onCollapsedGroupsChange } = input;
  const axisKey = tableGroupingAxisKey(input.grouping);
  if (
    !(collapsedGroups && onCollapsedGroupsChange && groups) ||
    axisKey === null
  ) {
    return;
  }
  const collapsed = new Set(collapsedGroups[axisKey] ?? []);
  return {
    isCollapsed: (groupKey) => collapsed.has(groupKey),
    setCollapsed: (groupKey, isCollapsed) =>
      onCollapsedGroupsChange(
        nextCollapsedGroups(collapsedGroups, axisKey, groupKey, isCollapsed, {
          isCompletePopulation: input.isCompletePopulation,
          renderedKeys: renderedTableGroupKeys(groups),
        })
      ),
  };
}

/**
 * The stored record with the linked axis replaced by what the link states. A
 * link that names a grouping and no collapsed band states that axis fully open;
 * every other axis keeps what the reader stored.
 */
export function overlayLinkedCollapsedGroups(
  stored: Readonly<TableCollapsedGroups>,
  linked: {
    collapsedGroups: Readonly<TableCollapsedGroups>;
    grouping: TableGroupingState;
  }
): TableCollapsedGroups {
  const axisKey = tableGroupingAxisKey(linked.grouping);
  const others = Object.entries(stored).filter(([axis]) => axis !== axisKey);
  const linkedKeys =
    axisKey === null ? [] : (linked.collapsedGroups[axisKey] ?? []);
  return Object.fromEntries(
    axisKey === null || linkedKeys.length === 0
      ? others
      : [...others, [axisKey, linkedKeys]]
  );
}

function nonEmptyAxes(record: Readonly<TableCollapsedGroups>): string[] {
  return Object.keys(record).filter((axis) => (record[axis]?.length ?? 0) > 0);
}

function cleanCollapsedGroups(value: unknown): TableCollapsedGroups {
  const record = UNKNOWN_RECORD_SCHEMA.safeParse(value);
  if (!record.success) {
    return {};
  }
  const cleaned: TableCollapsedGroups = {};
  let axes = 0;
  for (const [axis, keys] of Object.entries(record.data)) {
    // A real axis key always carries the separator, which also keeps a stored
    // `__proto__` from ever being assigned onto the result.
    if (!axis.includes(AXIS_SEPARATOR)) {
      continue;
    }
    const clean = cleanCollapsedGroupKeys(keys);
    if (clean.length === 0) {
      continue;
    }
    cleaned[axis] = clean;
    axes += 1;
    if (axes === MAX_COLLAPSED_GROUP_KEYS_PER_AXIS) {
      break;
    }
  }
  return cleaned;
}

const STRING_SCHEMA = z.string();
const UNKNOWN_LIST_SCHEMA = z.array(z.unknown());
const UNKNOWN_RECORD_SCHEMA = z.record(z.string(), z.unknown());

/** Repeated URL values preserve composed keys containing commas or slashes. */
export const TABLE_COLLAPSED_GROUP_PARAM = "collapsed" as const;

/** Restore only the active axis; a group key has no meaning without it. */
export function readTableCollapsedGroupParams(
  params: Pick<URLSearchParams, "getAll">,
  grouping: TableGroupingState
): TableCollapsedGroups {
  const axis = tableGroupingAxisKey(grouping);
  const keys = cleanCollapsedGroupKeys(
    params.getAll(TABLE_COLLAPSED_GROUP_PARAM)
  );
  return axis !== null && keys.length > 0 ? { [axis]: keys } : {};
}

/** A shared link describes the active axis, leaving all other URL state intact. */
export function writeTableCollapsedGroupParams(
  params: URLSearchParams,
  grouping: TableGroupingState,
  collapsedGroups: Readonly<TableCollapsedGroups>
): void {
  params.delete(TABLE_COLLAPSED_GROUP_PARAM);
  const axis = tableGroupingAxisKey(grouping);
  if (axis === null) {
    return;
  }
  for (const key of collapsedGroups[axis] ?? []) {
    params.append(TABLE_COLLAPSED_GROUP_PARAM, key);
  }
}
