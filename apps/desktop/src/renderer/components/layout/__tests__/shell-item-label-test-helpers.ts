import {
  SHELL_NAVIGATION_ITEMS,
  type ShellNavigationItemId,
} from "@repo/app/shared/lib/shell-navigation-contract";

export function shellItemLabel(id: ShellNavigationItemId): string {
  const item = SHELL_NAVIGATION_ITEMS.find((entry) => entry.id === id);
  if (!item) {
    throw new Error(`No shell navigation item ${id}`);
  }
  return item.label;
}
