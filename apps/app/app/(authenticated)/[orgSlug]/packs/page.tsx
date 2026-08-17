import { PacksPage } from "@repo/app/packs/components/packs-page";
import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { auth } from "@repo/auth/server";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { Metadata } from "next";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { Header } from "../../components/header";
import { AdminPacksView } from "./components/admin-packs-view";
import { MemberPacksView } from "./components/member-packs-view";

export const metadata: Metadata = {
  title: "Packs",
  description:
    "Author and distribute Packs: bundles of skills, commands, agents, hooks, plugins, and MCPs for your org",
};

type PageProps = {
  readonly params: Promise<{ orgSlug: string }>;
};

/**
 * Top-level Packs page (FEA-4087 Slice 1).
 *
 * One route, capability-driven: the same server-side role lookup as the former
 * `admin/catalog` page (`has({ role })`) seeds a `WebAdmin` vs `WebMember`
 * `PacksContext`, and the shared `PacksPage` spine picks the manage-first admin
 * treatment or the member by-source treatment from that capability. This
 * replaces the split-brain where admins got `/admin/catalog` and members got a
 * footer under Plugins.
 *
 * Each slot renders its realized treatment: an admin gets the manage-first
 * `AdminPacksView` (FEA-4088), and a member gets the by-source `MemberPacksView`
 * (FEA-4089 — a "Your packs" table grouped into Required / Installed with honest
 * per-row provenance, plus an "Available" catalog list). The spine picks between
 * them from the `manageDistribution` capability, so the split stays
 * capability-driven rather than a page-level `isAdmin` boolean.
 */
export default async function PacksRoutePage({ params }: PageProps) {
  // `params` is awaited to satisfy the dynamic-segment contract even though the
  // breadcrumb + capability lookup don't read orgSlug (auth() carries the org).
  const [{ has }] = await Promise.all([auth(), params]);

  const isAdmin = has({ role: "org:admin" }) || has({ role: "org:owner" });
  const context = createPacksContext(
    isAdmin ? PacksMode.WebAdmin : PacksMode.WebMember
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ISS-5037: the route CHROME stays OUTSIDE the gate. The breadcrumb and
          the page frame are the same whether or not Labs is on, and keeping
          them server-rendered means a gated route opens with its shell already
          painted instead of a blank region that pops the whole page in at once
          once PostHog (and the identify handshake behind it) settles. */}
      <Header breadcrumbs={[{ label: "Packs" }]} />
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
        {/* ISS-5037 (ISS-4779 closed-by-default): Packs is a Labs destination,
            so the route BODY carries the same container gate that hides the
            Labs nav section. Hiding the nav link while leaving this URL
            reachable would defeat the gate — with the flag off a direct visit
            lands on the in-shell "Page not found" recovery state via
            `notFound()`, matching Insights. The gate is a client component; the
            server-rendered body below is passed as children, so the capability
            lookup above is unchanged. */}
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
      </div>
    </div>
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
