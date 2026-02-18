import { parseDateLocal } from "./date-utils";

export function sortByDateDesc<T>(items: T[], dateKey: keyof T): T[] {
  return [...items].sort((a, b) => {
    const aValue = a[dateKey];
    const bValue = b[dateKey];
    const aDate =
      typeof aValue === "string" ? parseDateLocal(aValue) : (aValue as Date);
    const bDate =
      typeof bValue === "string" ? parseDateLocal(bValue) : (bValue as Date);
    return bDate.getTime() - aDate.getTime();
  });
}

export type SortDirection = "asc" | "desc";

export type SortConfig<T> = {
  key: keyof T | string;
  comparator?: (a: T, b: T) => number;
  columnType?: "string" | "number" | "date";
};

function compareSortValues<T>(
  a: T,
  b: T,
  config: SortConfig<T>,
  direction: SortDirection
): number {
  if (config.comparator) {
    const result = config.comparator(a, b);
    return direction === "asc" ? result : -result;
  }

  const aValue = (a as Record<string, unknown>)[config.key as string];
  const bValue = (b as Record<string, unknown>)[config.key as string];

  // Nulls-last: null/undefined values always sort to the end
  const aNull = aValue == null;
  const bNull = bValue == null;
  if (aNull && bNull) {
    return 0;
  }
  if (aNull) {
    return 1;
  }
  if (bNull) {
    return -1;
  }

  if (config.columnType === "date") {
    const aDate =
      typeof aValue === "string" ? parseDateLocal(aValue) : (aValue as Date);
    const bDate =
      typeof bValue === "string" ? parseDateLocal(bValue) : (bValue as Date);
    const result = aDate.getTime() - bDate.getTime();
    return direction === "asc" ? result : -result;
  }

  if (config.columnType === "number") {
    const aNum = aValue as number;
    const bNum = bValue as number;
    const result = aNum - bNum;
    return direction === "asc" ? result : -result;
  }

  const aStr = String(aValue ?? "");
  const bStr = String(bValue ?? "");
  const result = aStr.localeCompare(bStr);
  return direction === "asc" ? result : -result;
}

export function sortItems<T>(
  items: T[],
  config: SortConfig<T>,
  direction: SortDirection
): T[] {
  return [...items].sort((a, b) => compareSortValues(a, b, config, direction));
}

export function sortTableData<T>(
  items: T[],
  sortBy: string | null,
  configs: Record<string, SortConfig<T>>,
  sortDir: SortDirection
): T[] {
  if (!sortBy) {
    return items;
  }
  const config = configs[sortBy] as SortConfig<T> | undefined;
  if (!config) {
    return items;
  }
  return sortItems(items, config, sortDir);
}
