import { sessionDetailHref } from "../navigation/route-table";

type SessionHrefItem = {
  id: string;
};

/**
 * Builds hash-safe hrefs for shared components that render plain anchors
 * instead of the navigation-port Link component.
 */
export function desktopSessionDetailHashHref(item: SessionHrefItem): string {
  return `#${sessionDetailHref(item.id)}`;
}
