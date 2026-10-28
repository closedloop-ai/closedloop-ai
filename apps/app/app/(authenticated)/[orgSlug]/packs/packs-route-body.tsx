import { PacksPage } from "@repo/app/packs/components/packs-page";
import type { PacksContext } from "@repo/app/packs/lib/packs-context";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { AdminPacksView } from "./components/admin-packs-view";
import { MemberPacksView } from "./components/member-packs-view";

/**
 * The Packs body, shared by the grid route and the ISS-6925 detail route.
 *
 * Extracted so `/packs` and `/packs/{id}` render the SAME tree: the detail is
 * the same workspace with a pack selected, exactly as a card click renders it,
 * so the two routes cannot drift into two treatments of one surface.
 *
 * The Labs container gate lives here rather than in each page because it is a
 * property of the Packs destination, not of either route (ISS-5037).
 */
export function PacksRouteBody({
  context,
}: {
  readonly context: PacksContext;
}) {
  // ISS-5037 (ISS-4779 closed-by-default): Packs is a Labs destination, so
  // the route BODY carries the same container gate that hides the Labs nav
  // section. Hiding the nav link while leaving these URLs reachable would
  // defeat the gate — with the flag off a direct visit lands on the in-shell
  // "Page not found" recovery state via `notFound()`, matching Insights.
  return (
    <FeatureFlagRouteGate
      flag={LABS_NAV_SECTION_FEATURE_FLAG_KEY}
      pending={<PacksBodySkeleton />}
    >
      <PacksPage
        adminView={<AdminPacksView />}
        context={context}
        memberView={<MemberPacksView />}
      />
    </FeatureFlagRouteGate>
  );
}

/**
 * ISS-5037: what the Packs body shows while the Labs container flag is still
 * resolving. A skeleton the shape of the packs table — never a blank region,
 * and never the page's own "no packs" empty state, which would claim a settled
 * zero for a page that has not decided whether it exists yet.
 */
function PacksBodySkeleton() {
  return (
    <div
      aria-label="Loading packs"
      aria-live="polite"
      className="flex flex-col gap-4"
      role="status"
    >
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
