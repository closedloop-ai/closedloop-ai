import {
  SidebarInset,
  SidebarProvider,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import type { BranchCommentsControl } from "@repo/app/branches/components/branch-detail-page";
import { BranchCommentsToggle } from "@repo/app/branches/components/comments/branch-comments-toggle";
import { useBranchCommentsControl } from "@repo/app/branches/components/comments/use-branch-comments-control";
import {
  resolveBranchBackHref,
  resolveBranchBackLabel,
} from "@repo/app/branches/lib/branch-back-href";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  NAV_FROM_PARAM,
  resolveNavReferrerSurface,
} from "@repo/app/shared/lib/nav-referrer";
import { parsePath } from "@repo/navigation/href-store";
import { NavigationProvider } from "@repo/navigation/provider";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY } from "../shared/desktop-compute-progress-count-flag";
import {
  DESKTOP_DB_AHEAD_BANNER_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
  DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY,
} from "../shared/feature-flags";
import { AgentMonitorDbAheadBanner } from "./components/agent-monitor-db-ahead-banner";
import { BranchesLoading } from "./components/branches/branches-loading";
import { CommandPalette } from "./components/command-palette/command-palette";
import { DashboardFallback } from "./components/dashboard/dashboard-fallback";
import { DesktopSessionExpiredBanner } from "./components/desktop-session-expired-banner";
import { DesktopSyncPrompt } from "./components/desktop-sync-prompt";
import { FirstLaunchImportBanner } from "./components/first-launch-import-banner";
import { labsGatedPage } from "./components/labs-gate-surfaces";
import { MacWindowControlsUnderlay } from "./components/layout/mac-window-controls-underlay";
import { Sidebar } from "./components/layout/Sidebar";
import { Topbar } from "./components/layout/Topbar";
import { GuestLandingGate } from "./components/onboarding/guest-landing-gate";
import { GuestSignupProvider } from "./components/onboarding/guest-signup-provider";
import { InviteSpotlightProvider } from "./components/onboarding/invite-spotlight";
import { SyncConsentTakeoverGate } from "./components/onboarding/sync-consent-takeover-gate";
import { OptInDistributionsBanner } from "./components/opt-in-distributions-banner";
import {
  DetailFallbackKind,
  detailFallbackFor,
  PageFallback,
} from "./components/route-fallbacks";
import { StartupReadinessPanel } from "./components/startup-readiness/startup-readiness-panel";
import { UpdateBanner } from "./components/UpdateBanner";
import { DesktopFeatureFlagProvider } from "./feature-flags/desktop-feature-flag-provider";
import { lazyWithRetry } from "./lazy-with-retry";
import {
  activeDetailTitleKey,
  buildBreadcrumbs,
  sessionsBreadcrumbHref,
} from "./navigation/breadcrumb-model";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "./navigation/desktop-adapter";
import {
  DetailTitleProvider,
  resolveDetailTitle,
  resolveDetailTitleSettled,
  useDetailTitle,
} from "./navigation/detail-title-context";
import {
  DocsAnchorProvider,
  useResolvedDocsAnchor,
} from "./navigation/docs-anchor-context";
import {
  DEFAULT_NAV_ID,
  hrefForNavId,
  matchRoute,
  NavId,
  normalizeNavId,
  SETTINGS_TAB_PARAM,
} from "./navigation/route-table";
import { useDesktopDocumentTitle } from "./navigation/use-desktop-document-title";
import {
  LabsPageOutcome,
  resolveLabsPageOutcome,
  useDesktopNavGates,
} from "./navigation/use-nav-gates";
import {
  readRendererBooleanPreference,
  writeRendererBooleanPreference,
} from "./shared/renderer-preference-storage";

const DashboardPage = lazyWithRetry(() =>
  import("./components/dashboard/DashboardPage").then((m) => ({
    default: m.DashboardPage,
  }))
);
const SettingsPanel = lazyWithRetry(() =>
  import("./components/settings/SettingsPanel").then((m) => ({
    default: m.SettingsPanel,
  }))
);
const BranchesView = lazyWithRetry(() =>
  import("./components/branches/branches-view").then((m) => ({
    default: m.BranchesView,
  }))
);
const InsightsView = lazyWithRetry(() =>
  import("./components/insights/insights-view").then((m) => ({
    default: m.InsightsView,
  }))
);
const AuditView = lazyWithRetry(() =>
  import("./components/audit/audit-view").then((m) => ({
    default: m.AuditView,
  }))
);
const PlansView = lazyWithRetry(() =>
  import("./components/features/CoreFeaturesView").then((m) => ({
    default: m.PlansView,
  }))
);
const ApprovalsPanel = lazyWithRetry(() =>
  import("./components/approvals/ApprovalsPanel").then((m) => ({
    default: m.ApprovalsPanel,
  }))
);
const ActivityPanel = lazyWithRetry(() =>
  import("./components/activity/ActivityPanel").then((m) => ({
    default: m.ActivityPanel,
  }))
);
const DiagnosticsView = lazyWithRetry(() =>
  import("./components/diagnostics/diagnostics-view").then((m) => ({
    default: m.DiagnosticsView,
  }))
);
const SessionsView = lazyWithRetry(() =>
  import("./components/sessions/SessionsView").then((m) => ({
    default: m.SessionsView,
  }))
);
const SessionDetailView = lazyWithRetry(() =>
  import("./components/sessions/SessionDetailView").then((m) => ({
    default: m.SessionDetailView,
  }))
);
/**
 * ISS-5607. LAZY, like every other route-owned view in this shell, and not for
 * bundle size: it reaches `useAgentSessionDetail`, so importing it eagerly pulls
 * the shared agents/query stack into the shell's own module graph and breaks the
 * contract `insights-route-lazy-load.test.tsx` pins — the desktop shell must
 * paint before the shared analytics/session modules are imported. An eager
 * import here fails that test plus three app-shell suites.
 */
const SessionReadSourceTopbarAction = lazyWithRetry(() =>
  import("./components/sessions/session-read-source-topbar-action").then(
    (m) => ({ default: m.SessionReadSourceTopbarAction })
  )
);
const BranchDetailView = lazyWithRetry(() =>
  import("./components/branches/branch-detail-view").then((m) => ({
    default: m.BranchDetailView,
  }))
);
const AgentsView = lazyWithRetry(() =>
  import("./components/agents/agents-view").then((m) => ({
    default: m.AgentsView,
  }))
);
const PacksView = lazyWithRetry(() =>
  import("./components/packs/packs-view").then((m) => ({
    default: m.PacksView,
  }))
);
const RoutinesView = lazyWithRetry(() =>
  import("./components/routines/routines-view").then((m) => ({
    default: m.RoutinesView,
  }))
);
const AgentDetailView = lazyWithRetry(() =>
  import("./components/agents/agent-detail-view").then((m) => ({
    default: m.AgentDetailView,
  }))
);
const HelpView = lazyWithRetry(() =>
  import("./components/help/help-view").then((m) => ({
    default: m.HelpView,
  }))
);

let defaultDesktopNavigation: DesktopNavigation | null = null;

function getDefaultDesktopNavigation(): DesktopNavigation {
  // One-time renderer initialization (FEA-1518): the navigation port adapter
  // owns location state - hash persistence, legacy-hash migration, and the
  // nav-stack - and is mounted once for the lifetime of the window.
  defaultDesktopNavigation ??= createDesktopNavigation();
  return defaultDesktopNavigation;
}

// Agents workspace does its own data fetching (local IPC source + live bridge),
// so it is intentionally NOT excluded from keep-alive (the workspace stays
// mounted across tab switches at zero extra refetch cost).
const KeepAliveExcludedNavIds = new Set<NavId>([NavId.Insights]);
const DESKTOP_SIDEBAR_OPEN_STORAGE_KEY = "closedloop.desktop.sidebar.open";
const MAX_CONTENT_SCROLL_RESTORE_ATTEMPTS = 30;
const desktopContentScrollPositions = new Map<string, number>();

function shouldKeepNavMounted(navId: NavId): boolean {
  return !KeepAliveExcludedNavIds.has(navId);
}

export default function App() {
  const navigation = getDefaultDesktopNavigation();
  return <DesktopNavigationApp navigation={navigation} />;
}

export function DesktopNavigationApp({
  navigation,
}: Readonly<{ navigation: DesktopNavigation }>) {
  return (
    <NavigationProvider adapter={navigation.adapter}>
      <DesktopFeatureFlagProvider>
        <DetailTitleProvider>
          <DocsAnchorProvider>
            {/* ISS-5112 (PLN-1600 Step D): the guest sign-up ask and its
                resume-after-signup intent. Mounted here because its four entry
                points — the topbar, the sidebar's invite item, the dashboard's
                scope toggle, and the tour — are siblings with no common owner
                further down. Inert with the `guest-onboarding` flag off. */}
            {/* ISS-5112 (PLN-1600 Step F): the first-run landing REPLACES the
                shell rather than covering it, so the dashboard behind it cannot
                play its reveal and burn the one-shot guided tour while nobody is
                looking. Outside GuestSignupProvider because the landing makes
                its own ask and needs none of that machinery. Inert with the
                `guest-onboarding` flag off, and never shown to an install that
                has already completed a first launch. */}
            <GuestLandingGate>
              <GuestSignupProvider>
                {/* ISS-5489 (PLN-1694 M1): the post-auth consent takeover.
                    Mounted here, not in DashboardPage, because a returning user
                    lands on Sessions (DEFAULT_NAV_ID) — a Dashboard-scoped
                    overlay would never fire. Inside GuestLandingGate so the
                    pre-auth landing still wins on a first run, and inert with
                    the `guest-onboarding` flag off. */}
                <SyncConsentTakeoverGate>
                  <AppShell navigation={navigation} />
                </SyncConsentTakeoverGate>
              </GuestSignupProvider>
            </GuestLandingGate>
          </DocsAnchorProvider>
        </DetailTitleProvider>
      </DesktopFeatureFlagProvider>
    </NavigationProvider>
  );
}

function AppShell({ navigation }: Readonly<{ navigation: DesktopNavigation }>) {
  const { navigate } = useNavigation();
  const [sidebarOpen, setSidebarOpen] = useState(readDesktopSidebarOpen);
  const path = usePath();
  const searchParams = useSearchParamsValue();
  const settingsDeepLinkTab = searchParams.get(SETTINGS_TAB_PARAM);
  const query = searchParams.toString();
  const currentHref = query ? `${path}?${query}` : path;
  const route = matchRoute(path);
  const routeNavId = route?.kind === "nav" ? route.navId : null;
  const detailSessionId =
    route?.kind === "session-detail" ? route.sessionId : null;
  const detailBranchId =
    route?.kind === "branch-detail" ? route.branchId : null;
  const detailAgentSlug =
    route?.kind === "agent-detail" ? route.agentSlug : null;
  const branchCommentsControl = useBranchCommentsControl(detailBranchId);

  // The session detail keeps the originating tab highlighted (and labeled in
  // the Topbar), so remember the last nav route across detail visits. When
  // the app restores directly onto a detail (reload, legacy tab+sessionId
  // hash), the originating tab comes from the adapter's seeded history.
  // Render-phase guarded update — the React-endorsed derive-state pattern.
  const initialNavId =
    routeNavId ?? lastNavIdFromHistory(navigation.getHistory());
  const [lastNavId, setLastNavId] = useState<NavId>(() => initialNavId);
  const [lastNavHref, setLastNavHref] = useState<string>(() =>
    routeNavId === null
      ? lastNavHrefFromHistory(navigation.getHistory(), initialNavId)
      : currentHref
  );
  if (routeNavId !== null && routeNavId !== lastNavId) {
    setLastNavId(routeNavId);
  }
  if (routeNavId !== null && currentHref !== lastNavHref) {
    setLastNavHref(currentHref);
  }
  // Flag-derived nav decisions, resolved once (see `use-nav-gates.ts`).
  //
  // ISS-5037: the Labs flag snapshot arrives asynchronously, and until it does a
  // default-OFF flag reads exactly like a user-disabled one. HIDING gated UI on
  // that reading is correct (stay dark), but committing a page to the CLOSED
  // surface on it is not: a user whose Labs setting is ON would be told their
  // own deep link is turned off before the real value landed. So the one-way
  // page decisions wait for the snapshot; only then does an unresolved gate
  // become a closed one.
  //
  // The nav id is NOT rewritten when the gate is closed: the page answers a
  // gated-off Labs destination with an in-shell "turned off" panel that names
  // it (see `labs-gate-surfaces.tsx`), so the hash, the breadcrumb, and the body
  // all keep naming the destination the user actually asked for.
  const {
    auditFlagOn,
    agentsFlagOn,
    labsNavOn,
    desktopFlagsResolved,
    hiddenNavIds,
  } = useDesktopNavGates();
  const navId = routeNavId ?? lastNavId;
  // FEA-3846 / PRD-555 M4: the docs anchor for the active list screen. Resolved
  // only for a nav route (routeNavId) — detail views (session/branch/agent) get
  // no "Help on this" affordance, so it stays null while a detail is open.
  const docsAnchor = useResolvedDocsAnchor(routeNavId);
  const activeNavScrollKey = routeNavId === null ? null : currentHref;
  const contentViewportRef = useRef<HTMLDivElement | null>(null);
  const handleContentViewportScroll = useCallback(() => {
    if (!(activeNavScrollKey && contentViewportRef.current)) {
      return;
    }
    rememberContentScrollPosition(
      activeNavScrollKey,
      contentViewportRef.current.scrollTop
    );
  }, [activeNavScrollKey]);

  useLayoutEffect(() => {
    if (!(activeNavScrollKey && contentViewportRef.current)) {
      return;
    }
    const scrollTop = desktopContentScrollPositions.get(activeNavScrollKey);
    if (scrollTop === undefined) {
      return;
    }
    return restoreContentScrollPosition(contentViewportRef.current, scrollTop);
  }, [activeNavScrollKey]);

  // Deferred nav id keeps the previous list view on screen while a lazily-loaded
  // chunk resolves (the pre-port code got this from startTransition around
  // setState; useSyncExternalStore updates cannot be transitions). ISS-4772: the
  // detail ids are intentionally NOT deferred — the visible detail content,
  // breadcrumb, and viewport class select off the LIVE ids so a route change
  // always commits, even when a deferred background render stalls after long
  // uptime. Only the keep-alive list body still holds the previous view during a
  // chunk load, where doing so is harmless.
  const deferredNavId = useDeferredValue(navId);

  // The open detail page (if any) publishes its name through this context; the
  // Topbar breadcrumb shows it as the trailing "> [name]" segment. The published
  // title is keyed to its detail and only used when that key matches the detail
  // currently shown — so a title published for a just-closed detail does not
  // flash under the new list for one frame.
  const publishedDetail = useDetailTitle();
  const activeDetailKey = activeDetailTitleKey(
    detailSessionId,
    detailBranchId,
    detailAgentSlug
  );
  const detailTitle = resolveDetailTitle(publishedDetail, activeDetailKey);
  // ISS-4839 (codex review on #4266): a settled-but-nameless detail (not-found,
  // provider error) publishes the same null title as a still-loading one, so the
  // breadcrumb needs this second signal to stop holding its pending slot open
  // against a body that has already committed to "not found".
  const detailTitleSettled = resolveDetailTitleSettled(
    publishedDetail,
    activeDetailKey
  );
  // ISS-5574: name the window tab after the page, from the same inputs the
  // breadcrumb above uses, so the two cannot disagree. Off by default behind the
  // shared web+desktop flag; scoped to the Sessions and Branches routes, so every
  // other surface keeps the entry HTML's title.
  //
  // `routeNavId`, NOT the sticky `navId` below: a non-nav route (agent detail)
  // borrows the last nav id, which on a direct load is DEFAULT_NAV_ID (Sessions),
  // and would title an agent-detail window "Sessions". See the resolver's doc.
  useDesktopDocumentTitle({
    enabled: useFeatureFlagEnabled(
      DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
    ),
    routeNavId,
    detailSessionId,
    detailBranchId,
    detailTitle,
  });

  // Keep-alive: views stay mounted (hidden) once visited so tab switches
  // do not refetch. Same render-phase guarded-update pattern as above.
  const [visitedNavIds, setVisitedNavIds] = useState<NavId[]>([deferredNavId]);
  if (!visitedNavIds.includes(deferredNavId)) {
    setVisitedNavIds([...visitedNavIds, deferredNavId]);
  }

  // IPC bridge: the main process (menu items, tray, deep links) sends
  // desktop:navigate-tab via preload; translate it into port navigation.
  useEffect(() => {
    const handler = (e: CustomEvent<string>) => {
      // A leading "/" marks a full org-relative href (e.g. a session-detail
      // deep link from a completion notification); a bare id is a nav tab
      // resolved through normalizeNavId.
      const detail = e.detail;
      navigate(
        detail.startsWith("/") ? detail : hrefForNavId(normalizeNavId(detail))
      );
    };
    window.addEventListener("desktop:navigate-tab", handler as EventListener);
    return () =>
      window.removeEventListener(
        "desktop:navigate-tab",
        handler as EventListener
      );
  }, [navigate]);

  const handleSidebarOpenChange = useCallback((open: boolean) => {
    setSidebarOpen(open);
    writeDesktopSidebarOpen(open);
  }, []);

  const renderPage = useCallback(
    (pageId: NavId, active: boolean) => {
      const labsOutcome = resolveLabsPageOutcome({
        active,
        desktopFlagsResolved,
        // ISS-5310: Agents is the one Labs destination with a per-item flag
        // nested inside the container gate, so it is the only page that passes
        // a `labsItemOn`. Both gates must be on for `#/agents` to render;
        // everything else in Labs is container-gated only. The `#/agents/<slug>`
        // DETAIL tier is decided by the same call below — this one only covers
        // the keep-alive nav map.
        labsItemOn: pageId === NavId.Agents ? agentsFlagOn : true,
        labsNavOn,
        pageId,
      });
      if (labsOutcome !== LabsPageOutcome.Render) {
        return labsGatedPage(labsOutcome, pageId, labsNavOn);
      }
      switch (pageId) {
        case NavId.Sessions:
          return <SessionsView />;
        case NavId.Dashboard:
          return <DashboardPage />;
        case NavId.Branches:
          // Dedicated Suspense boundary so the first-navigation chunk load shows
          // the branches skeleton (cards + table scaffold) instead of the shared
          // blank "Loading…" PageFallback flashing across the whole body (FEA-2932).
          return (
            <Suspense fallback={<BranchesLoading />}>
              <BranchesView />
            </Suspense>
          );
        case NavId.Agents:
          return <AgentsView />;
        case NavId.Packs:
          return <PacksView />;
        case NavId.Insights:
          return <InsightsView />;
        case NavId.Audit:
          // Flag-off hides the view entirely (the sidebar entry is already
          // hidden); a direct #/audit nav while off falls through to Sessions.
          return auditFlagOn ? <AuditView /> : <SessionsView />;
        case NavId.Plans:
          return <PlansView />;
        case NavId.Routines:
          return <RoutinesView />;
        case NavId.Approvals:
          return <ApprovalsPanel />;
        case NavId.Requests:
          return <ActivityPanel />;
        case NavId.Diagnostics:
          return <DiagnosticsView isActive={active} />;
        case NavId.Settings:
          // ISS-5310: the shell reads `?tab=` and hands it down, because the
          // shell is what sits inside the NavigationProvider — see the prop's
          // docstring in `SettingsPanel.tsx`.
          return <SettingsPanel deepLinkTab={settingsDeepLinkTab} />;
        case NavId.Help:
          // Flag-off hides the sidebar entry; HelpView also self-guards to null
          // so a direct #/help nav while off renders nothing (FEA-3844).
          return <HelpView />;
        default:
          return <SessionsView />;
      }
    },
    [
      auditFlagOn,
      agentsFlagOn,
      labsNavOn,
      desktopFlagsResolved,
      settingsDeepLinkTab,
    ]
  );

  // The keep-alive nav map is the fallback; detail tiers override it in order
  // session-detail → branch-detail.
  const sessionBackHref =
    detailSessionId === null
      ? lastNavHref
      : lastNavHrefFromHistory(navigation.getHistory(), navId);

  // The breadcrumb's "Sessions" parent returns to the originating sessions list
  // (preserving its page/filter and restored scroll) when the detail was opened
  // from there, else the canonical list — so the segment's label always matches
  // where it goes. This is the back affordance now that the in-page "Back to
  // Sessions" control is gone.
  const sessionsListHref = sessionsBreadcrumbHref(sessionBackHref);

  // Branch/agent details always return to their OWN list (see the render
  // comments below), via the last visited href of that section so the list's
  // query — FEA-3560 facet params, page, the Agents kind tab — survives the
  // round trip instead of remounting an unfiltered list.
  const branchesListHref = lastHrefForNavId(
    navigation.getHistory(),
    NavId.Branches
  );
  // FEA-4262: when the branch detail was opened via a session's Branch
  // cross-link (`?from=session`), Back returns to the sessions list the user
  // came from. Absent/unknown referrer → the branches list, as before. This
  // drives BOTH the breadcrumb parent segment (below) and the in-page error-
  // state back link from the same resolved destination + label, so the loaded
  // page's "Back" honors the referrer too — not only the not-found state — and
  // its label always matches where it goes.
  const branchReferrerSurface = resolveNavReferrerSurface(
    searchParams.get(NAV_FROM_PARAM)
  );
  const branchBackHref = resolveBranchBackHref({
    branchesHref: branchesListHref,
    from: branchReferrerSurface,
    sessionsHref: sessionsListHref,
  });
  const branchBackLabel = resolveBranchBackLabel({
    from: branchReferrerSurface,
    sessionsHref: sessionsListHref,
  });
  const agentsListHref = lastHrefForNavId(
    navigation.getHistory(),
    NavId.Agents
  );

  // Breadcrumb model (mirrors the web app's per-page `breadcrumbs` prop): detail
  // pages render "<List> / <name>" with the list segment linking back to its
  // list, and list pages render their nav section + label. Keyed off the LIVE
  // detail ids (ISS-4772) so the breadcrumb switches in lockstep with the URL —
  // a deferred background render that never commits after long uptime would
  // otherwise leave the breadcrumb stuck on the list while the route changed.
  const breadcrumbs = buildBreadcrumbs({
    detailSessionId,
    detailBranchId,
    detailAgentSlug,
    detailTitle,
    detailTitleSettled,
    navId,
    sessionsListHref,
    branchBackHref,
    branchBackLabel,
    agentsListHref,
  });

  // ISS-5310 (wongk cid 3726730878, stage cid 3726701517): the Agents DETAIL
  // tier is gated on exactly the same pair as `#/agents`. `renderPage` above
  // only covers the keep-alive nav map, and the detail override below replaces
  // `content` wholesale — so gating the list alone left a bookmarked or
  // relaunched `#/agents/<slug>` mounting the full agent detail screen out of a
  // section that had just been switched off, with a Back button aimed at the
  // list the same gate had withdrawn. `active: true` because a detail route IS
  // the visible content, which is also why `Unmount` is unreachable here.
  const agentDetailGate = resolveAgentDetailGate({
    agentSlug: detailAgentSlug,
    agentsFlagOn,
    desktopFlagsResolved,
    labsNavOn,
  });

  let content: ReactNode = (
    // FEA-2933: the dashboard renders its own PageShell + skeleton loading
    // treatment, so falling back to the generic centered "Loading…" while its
    // lazy chunk resolves produced a blank → skeleton → values two-stage
    // flicker. Show the dashboard-shaped fallback (same title + skeleton) when
    // the dashboard is the resolving route so the first frame already matches
    // the in-page loading state instead of a blank.
    <Suspense
      fallback={
        deferredNavId === NavId.Dashboard ? (
          <DashboardFallback />
        ) : (
          <PageFallback />
        )
      }
    >
      {visitedNavIds.map((pageId) => {
        const active = pageId === deferredNavId;
        if (!(active || shouldKeepNavMounted(pageId))) {
          return null;
        }
        return (
          <div
            aria-hidden={active ? undefined : true}
            className={active ? "block h-full" : "hidden h-full"}
            key={pageId}
          >
            {renderPage(pageId, active)}
          </div>
        );
      })}
    </Suspense>
  );
  // ISS-4772: select the rendered detail from the LIVE route ids, not their
  // `useDeferredValue` counterparts. After long uptime a deferred background
  // render can stop committing, so keying the visible content off the deferred
  // ids left the URL on a detail route while the body stayed on the list. The
  // live ids guarantee a route change always swaps the rendered view.
  // ISS-4772 (wongk cid 3696061975): key each detail view by its record id so a
  // detail A → detail B navigation REMOUNTS the view. React otherwise reuses the
  // element at this tree position across the two ids — only the query key and the
  // prop change, not the component instance — so the `refetchOnMount: "always"`
  // default on `agentSessionKeys.details()` never fires, and B's `staleTime:
  // Infinity` cache entry renders stale/empty without a read. The key forces the
  // mount that arms the refetch on every switch.
  if (detailSessionId) {
    content = (
      <Suspense fallback={detailFallbackFor(DetailFallbackKind.Session)}>
        <SessionDetailView
          backHref={sessionBackHref}
          key={detailSessionId}
          sessionId={detailSessionId}
        />
      </Suspense>
    );
  } else if (detailBranchId) {
    content = (
      <Suspense fallback={detailFallbackFor(DetailFallbackKind.Branch)}>
        {/* Branch detail's Back targets the resolved destination explicitly —
            not the contextual `navId`, which on a direct #/branches/:id load (or
            arrival from another section) would point "Back to Branches" at
            Sessions. Default: the Branches list via its last-visited href, which
            keeps the list's query (FEA-3560 facets, page) so Back reopens the
            filtered view. FEA-4262: a `?from=session` referrer instead resolves
            to the sessions list, with the label matched by `branchBackLabel`. */}
        <BranchDetailView
          backHref={branchBackHref}
          backLabel={branchBackLabel}
          branchId={detailBranchId}
          commentsControl={branchCommentsControl}
          key={detailBranchId}
        />
      </Suspense>
    );
  } else if (detailAgentSlug) {
    content = agentDetailContent({
      agentSlug: detailAgentSlug,
      agentsListHref,
      labsNavOn,
      outcome: agentDetailGate.outcome,
    });
  }

  // Session AND branch detail own their own internal scroll container (the
  // single `.sd3-scroll` / `.bq-page-scroll`), so the outer viewport must clip
  // and hand height down rather than scroll itself — otherwise the inner
  // `position: sticky` header never pins and the trace can't virtualize against
  // the page scroller. Every other route lets this viewport be the scroller.
  // ISS-5310: a gated-off agent detail is NOT the agent detail view — it is the
  // shared "turned off" `PageShell`, which owns no inner scroller — so it takes
  // the scrolling-viewport branch with every other page.
  const contentViewportClassName =
    detailSessionId || detailBranchId || agentDetailGate.open
      ? "flex min-h-0 flex-1 flex-col overflow-hidden"
      : "flex-1 overflow-auto";

  return (
    <SidebarProvider
      className="h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]"
      onOpenChange={handleSidebarOpenChange}
      open={sidebarOpen}
    >
      <MacWindowControlsUnderlay />
      {/* FEA-3845 / PRD-555 M3: ⌘K command palette hosting the Docs result group.
          Self-gates on the `docsHelp` Labs flag (renders null + no ⌘K listener
          when off). */}
      <CommandPalette />
      {/* ISS-5489 (PLN-1694 M2): the arrival nudge pointing at "Invite your
          team". Mounted INSIDE SidebarProvider because which control it anchors
          to depends on `isMobile`, and around both the sidebar and the topbar
          because those are the two hosts. Renders no DOM of its own, so the
          provider's flex layout is untouched. Inert with `guest-onboarding`
          off. */}
      <InviteSpotlightProvider>
        <Sidebar activeNav={navId} hiddenNavIds={hiddenNavIds} />
        <SidebarInset className="min-w-0 overflow-hidden">
          <Topbar
            actions={
              <>
                {/* ISS-5607: the session detail's read-source badge, beside the
                    "Sessions / <name>" breadcrumb it qualifies. Both actions are
                    route-scoped and mutually exclusive — each returns null off
                    its own detail route — so this row holds at most one.
                    Its own Suspense with a NULL fallback: the badge is lazy, and
                    a shared boundary would let its chunk load blank the Topbar
                    (breadcrumbs included) on first navigation to a session. A
                    disclosure that is not there yet shows nothing, which is also
                    the honest state while the read it describes is in flight. */}
                <Suspense fallback={null}>
                  <SessionReadSourceTopbarAction sessionId={detailSessionId} />
                </Suspense>
                <BranchDetailTopbarAction
                  branchId={detailBranchId}
                  commentsControl={branchCommentsControl}
                />
              </>
            }
            breadcrumbs={breadcrumbs}
            docsAnchor={docsAnchor}
          />
          {/* ISS-4714: the local DB is newer than this app build, so the Agent
            Monitor runtime is dead. Pinned first — a dead local runtime (parsing
            + cloud sync down) is the highest-severity app-wide signal.
            ISS-4792 (ISS-4779 closed-by-default): the gate reads a desktop Labs
            flag (default OFF) — the banner is not rendered until the user opts
            in. */}
          <DbAheadBannerGate />
          <UpdateBanner />
          <DesktopSessionExpiredBanner />
          <DesktopSyncPrompt />
          <StartupReadinessBannerGate />
          {/* FEA-4007: app-level opt-in install prompt. Mounted here (not inside
            the Labs-gated Agents view) so a targeted user is prompted for an
            org-distributed opt-in install on startup regardless of the Agents
            Workspace flag or the current tab. */}
          <OptInDistributionsBanner />
          <div
            className={contentViewportClassName}
            data-testid="desktop-content-viewport"
            onScroll={handleContentViewportScroll}
            ref={contentViewportRef}
          >
            {content}
          </div>
        </SidebarInset>
      </InviteSpotlightProvider>
    </SidebarProvider>
  );
}

function lastNavIdFromHistory(history: readonly string[]): NavId {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const match = matchRoute(parsePath(history[i]));
    if (match?.kind === "nav") {
      return match.navId;
    }
  }
  return DEFAULT_NAV_ID;
}

/**
 * Most recent nav-route href in history — any section by default, or only
 * `onlyNavId`'s section when given. Falls back to `fallbackNavId`'s canonical
 * href when history has no match.
 */
function lastNavHrefFromHistory(
  history: readonly string[],
  fallbackNavId: NavId,
  onlyNavId?: NavId
): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const href = history[i];
    const match = matchRoute(parsePath(href));
    if (
      match?.kind === "nav" &&
      (onlyNavId === undefined || match.navId === onlyNavId)
    ) {
      return href;
    }
  }
  return hrefForNavId(fallbackNavId);
}

/**
 * Last visited href of ONE SPECIFIC nav section, canonical when never visited.
 * Backs the branch/agent detail back targets: those always belong under their
 * own list (never the contextual nav), but a plain canonical href would drop
 * the list's query — its FEA-3560 facet params and page — so a detail visit
 * would return to an unfiltered list.
 */
function lastHrefForNavId(history: readonly string[], navId: NavId): string {
  return lastNavHrefFromHistory(history, navId, navId);
}

function rememberContentScrollPosition(href: string, scrollTop: number): void {
  if (!Number.isFinite(scrollTop)) {
    return;
  }
  desktopContentScrollPositions.set(href, Math.max(0, scrollTop));
  while (desktopContentScrollPositions.size > 50) {
    const firstKey = desktopContentScrollPositions.keys().next().value;
    if (firstKey === undefined) {
      return;
    }
    desktopContentScrollPositions.delete(firstKey);
  }
}

/**
 * Reads the Desktop renderer-only sidebar preference.
 * Missing, corrupt, or unavailable storage defaults expanded so startup never
 * depends on a local browser preference being readable.
 */
function readDesktopSidebarOpen(): boolean {
  return readRendererBooleanPreference(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY, true);
}

/**
 * Persists the Desktop renderer-only sidebar preference when localStorage is
 * available. Callers update React state first so write failures do not block UI.
 */
function writeDesktopSidebarOpen(open: boolean): void {
  writeRendererBooleanPreference(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY, open);
}

function restoreContentScrollPosition(
  element: HTMLElement,
  scrollTop: number
): () => void {
  let frame: number | null = null;
  let attempts = 0;
  let cancelled = false;

  function applyScroll() {
    if (cancelled) {
      return;
    }
    attempts += 1;
    const maxScrollTop = Math.max(
      0,
      element.scrollHeight - element.clientHeight
    );
    element.scrollTop =
      maxScrollTop > 0 ? Math.min(scrollTop, maxScrollTop) : scrollTop;
    if (
      scrollTop > 0 &&
      element.scrollTop <= 0 &&
      attempts < MAX_CONTENT_SCROLL_RESTORE_ATTEMPTS &&
      typeof globalThis.requestAnimationFrame === "function"
    ) {
      frame = globalThis.requestAnimationFrame(applyScroll);
    }
  }

  applyScroll();
  return () => {
    cancelled = true;
    if (
      frame !== null &&
      typeof globalThis.cancelAnimationFrame === "function"
    ) {
      globalThis.cancelAnimationFrame(frame);
    }
  };
}

/**
 * ISS-4792 (ISS-4779 closed-by-default policy for the ISS-4714 UI): the mount
 * gate for the "DB ahead / update required" banner. Reads the desktop
 * `db-ahead-banner` Labs flag (default OFF) and renders the banner only when the
 * user has opted in; when off it renders nothing, so the surface behaves exactly
 * as it did before the in-flight banner UI landed. Exported so the flag-off/on
 * gating can be asserted directly without mounting the whole App shell. The
 * banner itself still self-guards on the runtime `dbAhead` status.
 */
export function DbAheadBannerGate(): ReactNode {
  const enabled = useFeatureFlagEnabled(
    DESKTOP_DB_AHEAD_BANNER_FEATURE_FLAG_KEY
  );
  if (!enabled) {
    return null;
  }
  return <AgentMonitorDbAheadBanner />;
}

/**
 * ISS-4715 closed-by-default gate. OFF keeps the existing first-launch banner
 * mounted unchanged; ON swaps in the non-blocking, ordered readiness panel.
 */
export function StartupReadinessBannerGate(): ReactNode {
  const enabled = useFeatureFlagEnabled(
    DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY
  );
  // ISS-6241: read HERE rather than inside the banner. ISS-6118 left the banner
  // reading no flags at all, which is what keeps its many bare test mounts
  // working without a `FeatureFlagAdapterProvider`; this gate already has one.
  const showComputeProgress = useFeatureFlagEnabled(
    DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY
  );
  // ISS-6241 (wongk review): BOTH surfaces honour the count flag. The readiness
  // panel replaces the splash wholesale, so passing the flag to only one of them
  // left the Labs toggle reading ON while the visible surface named no
  // population at all.
  return enabled ? (
    <StartupReadinessPanel showComputeProgress={showComputeProgress} />
  ) : (
    <FirstLaunchImportBanner showComputeProgress={showComputeProgress} />
  );
}

/**
 * ISS-5310 (wongk cid 3726730878, stage cid 3726701517) — the Agents DETAIL
 * tier under the same nested Labs gate as the list.
 *
 * `renderPage` above gates only the keep-alive nav map; the detail override
 * replaces the shell's content wholesale, so gating the list alone left a
 * bookmarked or relaunched `#/agents/<slug>` mounting the full detail screen out
 * of a section that had been switched off, with a Back button aimed at the list
 * the same gate had withdrawn. `active: true` because a detail route IS the
 * visible content, which is also why `Unmount` is unreachable here.
 *
 * `open` folds in "is a detail route even active", so the shell reads one
 * boolean rather than re-deriving the pair at each use.
 */
function resolveAgentDetailGate({
  agentSlug,
  agentsFlagOn,
  desktopFlagsResolved,
  labsNavOn,
}: {
  agentSlug: string | null;
  agentsFlagOn: boolean;
  desktopFlagsResolved: boolean;
  labsNavOn: boolean;
}): { outcome: LabsPageOutcome; open: boolean } {
  const outcome = resolveLabsPageOutcome({
    active: true,
    desktopFlagsResolved,
    labsItemOn: agentsFlagOn,
    labsNavOn,
    pageId: NavId.Agents,
  });
  return {
    open: agentSlug !== null && outcome === LabsPageOutcome.Render,
    outcome,
  };
}

/** The agent-detail route body: the real view, or the shared Labs gate panel. */
function agentDetailContent({
  agentSlug,
  agentsListHref,
  labsNavOn,
  outcome,
}: {
  agentSlug: string;
  agentsListHref: string;
  labsNavOn: boolean;
  outcome: LabsPageOutcome;
}): ReactNode {
  if (outcome !== LabsPageOutcome.Render) {
    return labsGatedPage(outcome, NavId.Agents, labsNavOn);
  }
  return (
    <Suspense fallback={detailFallbackFor(DetailFallbackKind.Agent)}>
      {/* Agent detail always belongs under the Agents list, so Back targets it
          explicitly — not the contextual `navId`, which on a direct
          #/agents/:id load (or arrival from another section) would point
          "Back to Agents" at Sessions. The history lookup keeps the list's
          query (the URL-synced kind tab) so Back reopens the same tab. */}
      <AgentDetailView
        agentSlug={agentSlug}
        backHref={agentsListHref}
        key={agentSlug}
      />
    </Suspense>
  );
}

/** Render the approved Branch comments action only on Branch detail routes. */
function BranchDetailTopbarAction({
  branchId,
  commentsControl,
}: Readonly<{
  branchId: string | null;
  commentsControl: BranchCommentsControl;
}>) {
  if (!branchId) {
    return null;
  }
  return (
    <BranchCommentsToggle
      onOpenChange={commentsControl.onOpenChange}
      open={commentsControl.open}
      toggleRef={commentsControl.toggleRef}
    />
  );
}
