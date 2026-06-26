import { branchDetailHref } from "../navigation/route-table";

type BranchHrefItem = {
  id: string;
};

/**
 * Builds hash-safe hrefs for shared components that render plain anchors
 * instead of the navigation-port Link component. Mirrors
 * `desktopSessionDetailHashHref` so a `BranchesTable` row anchor is hash-safe
 * under the desktop nav-stack adapter.
 */
export function desktopBranchDetailHashHref(item: BranchHrefItem): string {
  return `#${branchDetailHref(item.id)}`;
}
