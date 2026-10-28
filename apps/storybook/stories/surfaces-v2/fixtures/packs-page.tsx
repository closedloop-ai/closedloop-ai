import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { PackDetailBreadcrumb } from "@/app/(authenticated)/[orgSlug]/packs/[id]/pack-detail-breadcrumb";
import { PacksRouteBody } from "@/app/(authenticated)/[orgSlug]/packs/packs-route-body";
import { Header } from "@/app/(authenticated)/components/header";
import { LivePage } from "../live-page";
import { LiveRoute } from "../live-route";

// `apps/app/.../packs/page.tsx` and `packs/[id]/page.tsx` are async server
// components: they read the caller's Clerk role, pick the Packs mode, and
// return this tree. The stories render the same tree with the mode the server
// would pick (admin for the signed-in admin, member otherwise).

const ORG_SLUG = "org-test";

export function packsContext(admin: boolean) {
  return createPacksContext(admin ? PacksMode.WebAdmin : PacksMode.WebMember);
}

/** The Packs list route (`/packs`). */
export function PacksListPage({ admin = true }: { admin?: boolean }) {
  return (
    <LiveRoute path="/packs">
      <LivePage activePath="/packs">
        <div className="flex min-h-0 flex-1 flex-col">
          <Header breadcrumbs={[{ label: "Packs" }]} />
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
            <PacksRouteBody context={packsContext(admin)} />
          </div>
        </div>
      </LivePage>
    </LiveRoute>
  );
}

/** The Pack detail route (`/packs/[id]`), with its detail-route gate already open. */
export function PackDetailPage({
  admin = true,
  packId,
}: {
  admin?: boolean;
  packId: string;
}) {
  return (
    <LiveRoute params={{ id: packId }} path={`/packs/${packId}`}>
      <LivePage activePath="/packs">
        <div className="flex min-h-0 flex-1 flex-col">
          <PackDetailBreadcrumb orgSlug={ORG_SLUG} packId={packId} />
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
            <PacksRouteBody context={packsContext(admin)} />
          </div>
        </div>
      </LivePage>
    </LiveRoute>
  );
}
