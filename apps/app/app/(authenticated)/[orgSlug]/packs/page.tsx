import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { hasAdminRole } from "@repo/app/shared/lib/role-utils";
import { auth } from "@repo/auth/server";
import type { Metadata } from "next";
import { Header } from "../../components/header";
import { PacksRouteBody } from "./packs-route-body";

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
 *
 * ISS-6925 moved the gated body into `PacksRouteBody`, shared with the
 * `/packs/{id}` detail route so both render one tree.
 */
export default async function PacksRoutePage({ params }: PageProps) {
  // `params` is awaited to satisfy the dynamic-segment contract even though the
  // breadcrumb + capability lookup don't read orgSlug (auth() carries the org).
  const [{ has }] = await Promise.all([auth(), params]);

  const isAdmin = hasAdminRole(has);
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
        <PacksRouteBody context={context} />
      </div>
    </div>
  );
}
