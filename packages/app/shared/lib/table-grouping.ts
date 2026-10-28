import { TableGroupOrder } from "@repo/design-system/components/ui/table-toolbar-model";

/** Partition mechanics shared by list adapters; adapters own identities and band metadata. */
function partitionGroupEntries<
  T,
  C extends { key: string },
  B extends { items: T[] },
>(
  rows: readonly T[],
  contributionOf: (row: T) => C,
  createBand: (contribution: C, firstRow: T) => B,
  appendContribution?: (band: B, contribution: C) => void
): [string, B][] {
  const bands = new Map<string, B>();
  for (const row of rows) {
    const contribution = contributionOf(row);
    const key = contribution.key;
    let band = bands.get(key);
    if (band) {
      appendContribution?.(band, contribution);
      band.items.push(row);
    } else {
      band = createBand(contribution, row);
      bands.set(key, band);
    }
  }
  return [...bands.entries()];
}

/** Preserve caller-defined ordering policy while sharing band ordering mechanics. */
export function orderGroupEntries<T extends { label: string }>(
  entries: readonly (readonly [string, T])[],
  order: TableGroupOrder,
  customOrder: readonly string[],
  options: GroupEntryOrderOptions<T> = {}
): (readonly [string, T])[] {
  const ordered = [...entries];
  if (order === TableGroupOrder.Custom) {
    return ordered.sort(([leftKey], [rightKey]) => {
      const leftIndex = customOrder.indexOf(leftKey);
      const rightIndex = customOrder.indexOf(rightKey);
      if (leftIndex === -1 && rightIndex === -1) {
        return 0;
      }
      if (leftIndex === -1) {
        return 1;
      }
      if (rightIndex === -1) {
        return -1;
      }
      return leftIndex - rightIndex;
    });
  }
  const compare = options.compare ?? compareGroupLabels;
  const descending = order === TableGroupOrder.Descending;
  ordered.sort((left, right) => {
    const comparison = compare(left, right);
    return descending && !options.reverseDescending ? -comparison : comparison;
  });
  return descending && options.reverseDescending ? ordered.reverse() : ordered;
}

/** A domain comparator can retain ordinal priorities or its established locale/tie policy. */
export type GroupEntryOrderOptions<T> = {
  compare?: (left: readonly [string, T], right: readonly [string, T]) => number;
  reverseDescending?: boolean;
};

function compareGroupLabels<T extends { label: string }>(
  [, left]: readonly [string, T],
  [, right]: readonly [string, T]
): number {
  return left.label.localeCompare(right.label, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** Build and order bands as one operation; list adapters supply only their domain policy. */
export function groupRowEntries<
  T,
  C extends { key: string },
  B extends { items: T[]; label: string },
>(
  rows: readonly T[],
  contributionOf: (row: T) => C,
  createBand: (contribution: C, firstRow: T) => B,
  options: GroupRowOptions<C, B> = {}
): (readonly [string, B])[] {
  const entries = partitionGroupEntries(
    rows,
    contributionOf,
    createBand,
    options.appendContribution
  );
  return orderGroupEntries(
    entries,
    options.order ?? TableGroupOrder.Custom,
    options.customOrder ?? [],
    options
  );
}

/** Ordering and canonical-value reconciliation remain caller policy. */
type GroupRowOptions<C, B> = GroupEntryOrderOptions<B> & {
  appendContribution?: (band: B, contribution: C) => void;
  customOrder?: readonly string[];
  order?: TableGroupOrder;
};
