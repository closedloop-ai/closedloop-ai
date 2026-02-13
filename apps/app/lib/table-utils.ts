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
