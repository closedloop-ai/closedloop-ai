/**
 * Desktop Packs view (FEA-4087 Slice 1, member slot realized in FEA-4166).
 *
 * The top-level, capability-driven Packs page on desktop. Mounts the shared
 * `PacksPage` spine (`@repo/app/packs`) so the admin/member split stays in
 * lockstep with the web `/packs` route. The treatment is picked from the
 * `PacksContext`, never a surface-local boolean.
 *
 * Desktop runs in the `DesktopTeam` capability context (no org distribution
 * authoring), so the spine always renders the member-facing pack surface.
 * FEA-4166 replaces the former flat `PluginsPanel` member slot with the shared
 * by-source `MemberView` (via `DesktopMemberPacksView`), matching the web
 * member treatment FEA-4089 (#3752) shipped — the grouped Required / Installed
 * "Your packs" table plus an Available region. The existing functional
 * `PluginsPanel` (the preserved `window.desktopApi.db.catalog*`
 * install/uninstall/update surface) is preserved as that view's Available slot,
 * so the desktop keeps its real install capability.
 *
 * `DesktopTeam` has no `manageDistribution` capability, so the admin slot is
 * never reached on desktop; it stays wired to `PluginsPanel` as an honest
 * fallback rather than a null. Each treatment owns its own loading / error /
 * empty states, so the spine's whole-page states stay off here.
 */

import { PacksPage } from "@repo/app/packs/components/packs-page";
import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { pageTitleForNav } from "../../navigation/nav-config";
import { NavId } from "../../navigation/route-table";
import { PluginsPanel } from "../agents/plugins-panel";
import { PageShell } from "../layout/page-shell";
import { DesktopMemberPacksView } from "./member-packs-view";

const DESKTOP_PACKS_CONTEXT = createPacksContext(PacksMode.DesktopTeam);

export function PacksView() {
  return (
    <PageShell fullWidth title={pageTitleForNav(NavId.Packs)}>
      <PacksPage
        adminView={<PluginsPanel />}
        context={DESKTOP_PACKS_CONTEXT}
        memberView={<DesktopMemberPacksView />}
      />
    </PageShell>
  );
}
