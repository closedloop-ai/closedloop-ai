import { MemberView } from "@repo/app/packs/components/member-view";
import { useAdminPackViews } from "@repo/app/packs/hooks/use-admin-pack-views";
import { useAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import { PluginsPanel } from "../agents/plugins-panel";

/**
 * Desktop-member Packs treatment (FEA-4166), wired to the desktop data ports.
 *
 * FEA-4089 (#3752) shipped the WEB member by-source treatment (grouped
 * Required / Installed "Your packs" table + Available catalog). Desktop's
 * `PacksView` still mounted the flat `PluginsPanel` for the member slot, so the
 * two surfaces of the same product diverged: web showed the grouped by-source
 * view, Electron showed the flat list. This adapter closes that parity gap by
 * mounting the same shared `MemberView` on the desktop member slot.
 *
 * The org catalog + distributions are folded into `PackView`s through
 * `useAdminPackViews` (`GET /catalog` + `GET /distributions`, both org-visible —
 * no admin gate). On desktop these resolve through the surface-agnostic
 * `useApiClient` / `useAuthSnapshot` ports the desktop core stack supplies:
 * `DesktopAppCoreProvider` mounts the `ApiAdapterProvider` (the `useApiClient`
 * transport), and the `DesktopAuthProvider` it wraps supplies the
 * `useAuthSnapshot` adapter. The same shared hook drives both surfaces without a
 * fork.
 *
 * Two things this adapter threads through the shared view (mirroring the web
 * adapter, `apps/app/.../packs/components/member-packs-view.tsx`):
 *  - `memberUserId` (from the desktop auth snapshot) scopes `specific`-targeting
 *    distributions to the targeted cohort, so an `auto_install specific` pack
 *    that names other members doesn't read as Required for this one. When the
 *    desktop session is signed out (`userId` null) a specific distribution
 *    degrades to not-Required rather than mislabelling every row.
 *  - `availableSlot` supplies the existing functional `PluginsPanel` as the
 *    "Available" region body. That panel is the preserved local
 *    `window.desktopApi.db.catalog*` install/uninstall/update surface, so the
 *    by-source treatment keeps the desktop's real install capability instead of
 *    demoting it to a read-only list.
 *
 * Honest scope note (projection gap, deferred from #3752): the list
 * `GET /distributions` carries no per-member `targetStatuses`, and
 * `catalogItemToPackView` sets `installedByMe=false`, so the accepted-opt-in /
 * self-installed / failed-install strands still can't be derived from the list
 * read alone. `groupMemberPacks` degrades honestly in that case — a required
 * pack with no per-target failure shows as required (not a fabricated failure),
 * and unresolved packs land in Available rather than a fake installed state. A
 * member-scoped install-status projection (per-member assignment + install
 * state) is a tight follow-up; until it lands the grouping stays honest rather
 * than inventing states.
 */
export function DesktopMemberPacksView() {
  const { userId } = useAuthSnapshot();
  const { packViews, isLoading, error } = useAdminPackViews({
    includeDistributions: true,
  });

  return (
    <MemberView
      availableSlot={<PluginsPanel />}
      error={error}
      isLoading={isLoading}
      memberUserId={userId}
      packs={packViews}
    />
  );
}
