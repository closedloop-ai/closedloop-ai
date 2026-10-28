import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { hasAdminRole } from "@repo/app/shared/lib/role-utils";
import { auth } from "@repo/auth/server";
import type { Metadata } from "next";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";
import { PacksRouteBody } from "../packs-route-body";
import {
  PACK_CRUMB_FALLBACK,
  PackDetailBreadcrumb,
} from "./pack-detail-breadcrumb";

export const metadata: Metadata = {
  title: "Pack",
  description: "View a pack's contents, distribution, and usage",
};

type PageProps = {
  readonly params: Promise<{ orgSlug: string; id: string }>;
};

/**
 * Addressable pack detail (ISS-6925).
 *
 * Renders the SAME body as `/packs` — the capability-driven spine and its
 * workspace — and lets the workspace's host read the `id` back through the
 * navigation port. There is no second detail component: a pack detail reached
 * by URL is the same view a card click produces, which is what keeps a reload
 * from landing somewhere the click never goes.
 *
 * Gated on its own closed-by-default key so the route is unreachable until the
 * flag is on; the Labs container gate inside `PacksRouteBody` still applies, so
 * a Labs-off org gets the same 404 the grid route gives.
 */
export default async function PackDetailRoutePage({ params }: PageProps) {
  const [{ has }, { orgSlug, id }] = await Promise.all([auth(), params]);

  const context = createPacksContext(
    hasAdminRole(has) ? PacksMode.WebAdmin : PacksMode.WebMember
  );

  return (
    <FeatureFlagRouteGate
      flag={PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY}
      pending={
        // The ancestor crumb carries its href here exactly as the loaded header
        // does, so only the leaf's text settles when the flag lands — never the
        // trail's shape.
        <RouteChromeFallback
          breadcrumbs={[
            { href: `/${orgSlug}/packs`, label: "Packs" },
            { label: PACK_CRUMB_FALLBACK },
          ]}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <PackDetailBreadcrumb orgSlug={orgSlug} packId={id} />
        {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
          <PacksRouteBody context={context} />
        </div>
      </div>
    </FeatureFlagRouteGate>
  );
}
