import {
  SHELL_NAVIGATION_GROUPS,
  SHELL_NAVIGATION_ITEMS,
  type ShellNavigationGroupId,
  type ShellNavigationItemId,
} from "@repo/app/shared/lib/shell-navigation-contract";

export function shellItemLabel(id: ShellNavigationItemId): string {
  const item = SHELL_NAVIGATION_ITEMS.find((entry) => entry.id === id);
  if (!item) {
    throw new Error(`No shell navigation item ${id}`);
  }
  return item.label;
}

export function shellGroupLabel(id: ShellNavigationGroupId): string {
  const group = SHELL_NAVIGATION_GROUPS.find((entry) => entry.id === id);
  if (!group) {
    throw new Error(`No shell navigation group ${id}`);
  }
  return group.label;
}
