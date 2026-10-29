import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import type { ShellNavigationRouteId } from "@repo/app/shared/lib/shell-navigation-contract";

export function primaryNavTitle(routeId: ShellNavigationRouteId): string {
  const destination = PRIMARY_NAV_DESTINATIONS.find(
    (entry) => entry.shellRouteId === routeId
  );
  if (!destination) {
    throw new Error(`No primary nav destination for ${routeId}`);
  }
  return destination.title;
}
