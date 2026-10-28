import {
  SidebarInset,
  SidebarProvider,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import { useBranchCommentsControl } from "@repo/app/branches/components/comments/use-branch-comments-control";
import {
  resolveBranchBackHref,
  resolveBranchBackLabel,
} from "@repo/app/branches/lib/branch-back-href";
import { DevToolsOverlay } from "@repo/app/shared/dev-tools/components/dev-tools-overlay";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  NAV_FROM_PARAM,
  resolveNavReferrerSurface,
} from "@repo/app/shared/lib/nav-referrer";
import { UndoKeybindingLayer } from "@repo/app/undo/components/undo-keybinding-layer";
import { UndoStackProvider } from "@repo/app/undo/hooks/use-undo-stack";
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
  useRef,
  useState,
} from "react";
import {
  DESKTOP_DB_AHEAD_BANNER_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
} from "../shared/feature-flags-labs-surfaces";
import { RendererReadyPhase } from "../shared/renderer-ready-phase";
import { AgentMonitorDbAheadBanner } from "./components/agent-monitor-db-ahead-banner";
import { DesktopAgentsDateWindowGate } from "./components/agents/agents-date-window-gate";
import { BranchesLoading } from "./components/branches/branches-loading";
import { CommandPalette } from "./components/command-palette/command-palette";
import { DashboardFallback } from "./components/dashboard/dashboard-fallback";
import { DesktopSessionExpiredBanner } from "./components/desktop-session-expired-banner";
import { DesktopSyncPrompt } from "./components/desktop-sync-prompt";
import { helpUnavailableAction } from "./components/help/help-unavailable-action";
import { labsGatedPage } from "./components/labs-gate-surfaces";
import { MacWindowControlsUnderlay } from "./components/layout/mac-window-controls-underlay";
import { Sidebar } from "./components/layout/Sidebar";
import { Topbar } from "./components/layout/Topbar";
import { AnalysisBannerOffsetProvider } from "./components/onboarding/analysis-banner-offset";
import { InviteSpotlightProvider } from "./components/onboarding/invite-spotlight";
import { OptInDistributionsBanner } from "./components/opt-in-distributions-banner";
import {
  DetailFallbackKind,
  detailFallbackFor,
  PageFallback,
} from "./components/route-fallbacks";
import { UpdateBanner } from "./components/UpdateBanner";
import { lazyWithRetry } from "./lazy-with-retry";
import {
  activeDetailTitleKey,
  buildBreadcrumbs,
  sessionsBreadcrumbHref,
} from "./navigation/breadcrumb-model";
import { contentViewportClasses } from "./navigation/content-viewport-classes";
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
  lastHrefForNavId,
  lastNavHrefFromHistory,
  lastNavIdFromHistory,
} from "./navigation/nav-history";
import { RouteScrollerProvider } from "./navigation/route-scroller-context";
import {
  hrefForNavId,
  matchRoute,
  NavId,
  normalizeNavId,
} from "./navigation/route-table";
import { useContentScrollRestoration } from "./navigation/use-content-scroll-restoration";
import { useDesktopDocumentTitle } from "./navigation/use-desktop-document-title";
import {
  LabsPageOutcome,
  resolveLabsItemGate,
  resolveLabsPageOutcome,
  useDesktopNavGates,
} from "./navigation/use-nav-gates";
import { DesktopSessionReplay } from "./session-replay/desktop-session-replay";
import { DesktopSettingsModalHost } from "./settings-v2/settings-route-experience";
import {
  resolveKeepAliveNavIds,
  resolveVisibleNavId,
  useSettingsReturnHref,
  useSettingsRouteExperience,
} from "./settings-v2/use-settings-route-experience";
import {
  readRendererBooleanPreference,
  writeRendererBooleanPreference,
} from "./shared/renderer-preference-storage";
import { useDesktopPageViewedEvent } from "./shared/use-desktop-page-viewed-event";

const DocumentsView = lazyWithRetry(() =>
  import("./components/documents/documents-view").then((m) => ({
    default: m.DocumentsView,
  }))
);
const DesktopDocumentDetailView = lazyWithRetry(() =>
  import("./components/documents/desktop-document-detail-view").then((m) => ({
    default: m.DesktopDocumentDetailView,
  }))
);

const IssuesView = lazyWithRetry(() =>
  import("./components/issues/issues-view").then((m) => ({
    default: m.IssuesView,
  }))
);

const DashboardPage = lazyWithRetry(() =>
  import("./components/dashboard/DashboardPage").then((m) => ({
    default: m.DashboardPage,
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
const DetailCommentsTopbarAction = lazyWithRetry(() =>
  import("./components/detail-comments-topbar-action").then((m) => ({
    default: m.DetailCommentsTopbarAction,
  }))
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

function shouldKeepNavMounted(navId: NavId): boolean {
  return !KeepAliveExcludedNavIds.has(navId);
}

/** Synchronizes the sticky nav route during render when the active nav changes. */
function syncLastNavRoute({
  currentHref,
  lastNavHref,
  lastNavId,
  routeNavId,
  setLastNavHref,
  setLastNavId,
}: {
  currentHref: string;
  lastNavHref: string;
  lastNavId: NavId;
  routeNavId: NavId | null;
  setLastNavHref: (href: string) => void;
  setLastNavId: (navId: NavId) => void;
}): void {
  if (routeNavId !== null && routeNavId !== lastNavId) {
    setLastNavId(routeNavId);
  }
  if (routeNavId !== null && currentHref !== lastNavHref) {
    setLastNavHref(currentHref);
  }
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
      <UndoStackProvider>
        <UndoKeybindingLayer />
        {/* ISS-12048: shared with web; renders nothing unless Dev Mode is
            on. */}
        <DevToolsOverlay />
        <DesktopSessionReplay />
        <DetailTitleProvider>
          <DocsAnchorProvider>
            <AppShell navigation={navigation} />
          </DocsAnchorProvider>
        </DetailTitleProvider>
      </UndoStackProvider>
    </NavigationProvider>
  );
}

const ProjectContextView = lazyWithRetry(() =>
  import("./components/projects/project-context-view").then((module) => ({
    default: module.ProjectContextView,
  }))
);

function AppShell({ navigation }: Readonly<{ navigation: DesktopNavigation }>) {
  const { navigate } = useNavigation();
  const navigationReadyNotified = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(readDesktopSidebarOpen);
  const path = usePath();
  const searchParams = useSearchParamsValue();
  const query = searchParams.toString();
  const currentHref = query ? `${path}?${query}` : path;
  const route = matchRoute(path);
  const requestedNavId = route?.kind === "nav" ? route.navId : null;
  // ISS-8370 D6: `#/settings` is the modal over the last nav page rather than a
  // page of its own, so every route-keyed read below sees `null` for it —
  // exactly as they do for a detail route.
  const settingsRoute = useSettingsRouteExperience(requestedNavId);
  const routeNavId = settingsRoute.routeNavId;
  const detailSessionId =
    route?.kind === "session-detail" ? route.sessionId : null;
  const detailBranchId =
    route?.kind === "branch-detail" ? route.branchId : null;
  const detailDocumentSlug =
    route?.kind === "document-detail" ? route.slug : null;
  const detailAgentSlug =
    route?.kind === "agent-detail" ? route.agentSlug : null;
  const navMapVisible = isNavMapVisible({
    projectRoute: route,
    detailDocumentSlug,
    detailAgentSlug,
    detailBranchId,
    detailSessionId,
  });
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
  syncLastNavRoute({
    currentHref,
    lastNavHref,
    lastNavId,
    routeNavId,
    setLastNavHref,
    setLastNavId,
  });
  // ISS-8370 D6: the Settings modal's close target — the last route but
  // Settings, nav page or DETAIL, unlike `lastNavHref` above (see the hook).
  const settingsReturnHref = useSettingsReturnHref(
    requestedNavId,
    currentHref,
    navigation.getHistory()
  );
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
    labsItemGates,
    agentsFlagOn,
    closedItemOutcomeFor,
    labsNavOn,
    desktopFlagsResolved,
    hiddenNavIds,
  } = useDesktopNavGates();
  const navId = resolveVisibleNavId(settingsRoute, lastNavId);
  // A document detail highlights Documents whichever list opened it (Kerensa Whitlock,
  // 2026-10-21, PLN-2217 Q-001/Q-003).
  const sidebarActiveNav = detailDocumentSlug ? NavId.Documents : navId;
  // FEA-3846 / PRD-555 M4: the docs anchor for the active list screen. Resolved
  // only for a nav route (routeNavId) — detail views (session/branch/agent) get
  // no "Help on this" affordance, so it stays null while a detail is open.
  const docsAnchor = useResolvedDocsAnchor(routeNavId);
  const {
    contentViewportRef,
    handleContentViewportScroll,
    registerRouteScroller,
  } = useContentScrollRestoration(routeNavId === null ? null : currentHref);

  // Deferred nav id keeps the previous list view on screen while a lazily-loaded
  // chunk resolves (the pre-port code got this from startTransition around
  // setState; useSyncExternalStore updates cannot be transitions). ISS-4772: the
  // detail ids are intentionally NOT deferred — the visible detail content,
  // breadcrumb, and viewport class select off the LIVE ids so a route change
  // always commits, even when a deferred background render stalls after long
  // uptime. Only the keep-alive list body still holds the previous view during a
  // chunk load, where doing so is harmless.
  const deferredNavId = useDeferredValue(navId);

  // PRD-736 (ISS-10502): `page_viewed` on the activation edge, off the LIVE
  // route values — the keep-alive map below never remounts a visited view, so
  // the web pages' per-mount emit has no desktop equivalent. `session_detail`
  // is owned by `SessionDetailView` (success-gated), not this hook.
  useDesktopPageViewedEvent({
    detailOpen: !navMapVisible,
    navId,
    settingsOpen: requestedNavId === NavId.Settings,
  });

  // The open detail page (if any) publishes its name through this context; the
  // Topbar breadcrumb shows it as the trailing "> [name]" segment. The published
  // title is keyed to its detail and only used when that key matches the detail
  // currently shown — so a title published for a just-closed detail does not
  // flash under the new list for one frame.
  const publishedDetail = useDetailTitle();
  const activeDetailKey = activeDetailTitleKey(
    detailSessionId,
    detailBranchId,
    detailAgentSlug,
    detailDocumentSlug
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
  // borrows the last nav id, so an agent detail reached from Sessions would keep
  // that window titled "Sessions". See the resolver's doc.
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
    if (!navigationReadyNotified.current) {
      navigationReadyNotified.current = true;
      window.desktopApi.notifyRendererReady(RendererReadyPhase.NavigationReady);
    }
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
    (pageId: NavId, active: boolean, visible: boolean) => {
      const labsOutcome = resolveLabsPageOutcome({
        active,
        desktopFlagsResolved,
        // ISS-5310 / ISS-9715 / ISS-9731: both gates must be on for a per-item
        // Labs destination to render, and which gate that is is derived from the
        // shared navigation contract by nav id rather than named inline here —
        // see `resolveLabsItemGate`. The `#/agents/<slug>` DETAIL tier is decided
        // by the same call below; this one only covers the keep-alive nav map.
        closedItemOutcome: closedItemOutcomeFor(pageId),
        labsItemOn: resolveLabsItemGate({ labsItemGates, pageId }),
        labsNavOn,
        pageId,
      });
      if (labsOutcome !== LabsPageOutcome.Render) {
        // ISS-9731: the destination supplies its own extra action, so the panel
        // never branches on which gate is closed. Only Help has one.
        return labsGatedPage(
          labsOutcome,
          pageId,
          helpUnavailableAction(pageId)
        );
      }
      switch (pageId) {
        case NavId.Documents:
          return <DocumentsView />;
        case NavId.Issues:
          return <IssuesView />;
        case NavId.Sessions:
          return <SessionsView isActive={visible} />;
        case NavId.Dashboard:
          return (
            <DashboardPage
              isActive={visible && requestedNavId !== NavId.Settings}
            />
          );
        case NavId.Branches:
          // Dedicated Suspense boundary so the first-navigation chunk load shows
          // the branches skeleton (cards + table scaffold) instead of the shared
          // blank "Loading…" PageFallback flashing across the whole body (FEA-2932).
          return (
            <Suspense fallback={<BranchesLoading />}>
              <BranchesView isActive={visible} />
            </Suspense>
          );
        case NavId.Agents:
          return (
            <DesktopAgentsDateWindowGate>
              <AgentsView />
            </DesktopAgentsDateWindowGate>
          );
        case NavId.Packs:
          return <PacksView />;
        case NavId.Insights:
          return <InsightsView />;
        case NavId.Plans:
          return <PlansView />;
        case NavId.Approvals:
          return <ApprovalsPanel />;
        case NavId.Requests:
          return <ActivityPanel />;
        case NavId.Diagnostics:
          return <DiagnosticsView isActive={active} />;
        case NavId.Help:
          // ISS-9731: the `docsHelp` gate is applied at the route above, so this
          // mounts only when Help is actually available.
          return <HelpView />;
        default:
          return <SessionsView isActive={visible} />;
      }
    },
    [
      labsItemGates,
      closedItemOutcomeFor,
      labsNavOn,
      desktopFlagsResolved,
      requestedNavId,
    ]
  );

  // The keep-alive nav map is the fallback; detail tiers override it in order
  // session-detail → branch-detail.
  const sessionBackHref =
    detailSessionId === null
      ? lastNavHref
      : lastNavHrefFromHistory(navigation.getHistory(), navId);

  // The coerced Sessions destination: the originating sessions list (preserving
  // its page/filter and restored scroll) when the detail was opened from there,
  // else the canonical list — so a control labelled "Sessions" always matches
  // where it goes. `sessionBackHref` above is the last nav route of ANY section,
  // so it is only ever safe to hand to something that does NOT name Sessions.
  // Both Sessions-labelled affordances resolve from this one value: the
  // breadcrumb parent segment, and the session detail's own "Back to Sessions"
  // link on its not-found and provider-error states.
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
    projectContext: projectRouteContext(route),
    detailDocumentSlug,
    documentsListHref: lastHrefForNavId(
      navigation.getHistory(),
      NavId.Documents
    ),
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

  // ISS-5310 (whitlockk cid 3726730878, stage cid 3726701517): the Agents DETAIL
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

  // FEA-2933: the dashboard renders its own PageShell + skeleton loading
  // treatment, so falling back to the generic centered "Loading…" while its
  // lazy chunk resolves produced a blank → skeleton → values two-stage
  // flicker. Show the dashboard-shaped fallback (same title + skeleton) when
  // the dashboard is the resolving route so the first frame already matches
  // the in-page loading state instead of a blank.
  const keepAliveContent: ReactNode = (
    <Suspense
      fallback={
        deferredNavId === NavId.Dashboard ? (
          <DashboardFallback />
        ) : (
          <PageFallback />
        )
      }
    >
      {resolveKeepAliveNavIds(visitedNavIds).map((pageId) => {
        const active = pageId === deferredNavId;
        if (!(active || shouldKeepNavMounted(pageId))) {
          return null;
        }
        // `data-nav-panel*` names WHICH view this panel is and WHETHER the shell
        // has committed to it. Both are read by desktop e2e (`activeNavPanel` in
        // `test/e2e/helpers/desktop-app.ts`) and neither affects rendering.
        // Without them the suite has no way to say "inside the view the shell
        // actually settled on": keep-alive leaves every visited view mounted, so
        // a page-global locator can resolve a control or a value belonging to a
        // DIFFERENT, hidden view. `:visible` only samples that — the panel is
        // mid-transition while the deferred render commits — so scoping has to
        // key off the committed panel, not off visibility at one instant.
        return (
          <div
            aria-hidden={active ? undefined : true}
            className={active ? "block h-full" : "hidden h-full"}
            data-nav-panel={pageId}
            data-nav-panel-state={active ? "active" : "inactive"}
            key={pageId}
          >
            <RouteScrollerProvider
              activeNavId={routeNavId}
              navId={pageId}
              registerRouteScroller={registerRouteScroller}
            >
              {renderPage(pageId, active, active && navMapVisible)}
            </RouteScrollerProvider>
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
  // ISS-4772 (whitlockk cid 3696061975): key each detail view by its record id so a
  // detail A → detail B navigation REMOUNTS the view. React otherwise reuses the
  // element at this tree position across the two ids — only the query key and the
  // prop change, not the component instance — so the `refetchOnMount: "always"`
  // default on `agentSessionKeys.details()` never fires, and B's `staleTime:
  // Infinity` cache entry renders stale/empty without a read. The key forces the
  // mount that arms the refetch on every switch.
  const content = selectRouteContent({
    route,
    keepAliveContent,
    detailSessionId,
    detailBranchId,
    detailAgentSlug,
    sessionsListHref,
    branchBackHref,
    branchBackLabel,
    branchCommentsControl,
    agentsListHref,
    agentDetailOutcome: agentDetailGate.outcome,
    labsItemGates,
    labsNavOn,
    desktopFlagsResolved,
  });

  // Session AND branch detail own their own internal scroll container (the
  // single `.sd3-scroll` / `.bq-page-scroll`), so the outer viewport must clip
  // and hand height down rather than scroll itself — otherwise the inner
  // `position: sticky` header never pins and the trace can't virtualize against
  // the page scroller. Every other route lets this viewport be the scroller.
  // ISS-5310: a gated-off agent detail is NOT the agent detail view — it is the
  // shared "turned off" `PageShell`, which owns no inner scroller — so it takes
  // the scrolling-viewport branch with every other page.
  const contentViewportClassName = contentViewportClasses({
    detailSessionId,
    detailBranchId,
    detailDocumentSlug,
    agentDetailOpen: agentDetailGate.open,
  });

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
          provider's flex layout is untouched. */}
      <InviteSpotlightProvider>
        {/* ISS-10492: the ambient analysis bar is `position: fixed`, so nothing
            beneath it moves on its own. This reserves the space it occupies on
            the REAL `SidebarInset` below — a wrapper standing in for the inset
            would let the offset be deleted from the shell with the test still
            green. No `transition` on that margin, deliberately: animating it
            re-lays-out the bar's own box for 300ms and was half of the
            ISS-10492 feedback loop. */}
        <AnalysisBannerOffsetProvider>
          {(analysisBannerOffsetPx) => (
            <>
              <Sidebar
                activeNav={sidebarActiveNav}
                hiddenNavIds={hiddenNavIds}
              />
              <SidebarInset
                className="min-w-0 overflow-hidden"
                // No inline style at all at rest: `variant="inset"` gives this
                // element an `m-2`, and an unconditional `marginTop: 0` would
                // override that top margin and shift the whole shell up by 8px
                // whenever the bar is absent — which is almost always.
                style={
                  analysisBannerOffsetPx > 0
                    ? { marginTop: `${analysisBannerOffsetPx}px` }
                    : undefined
                }
              >
                <Topbar
                  actions={
                    <>
                      {/* ISS-5607: the session detail's read-source badge, beside the
                      "Sessions / <name>" breadcrumb it qualifies. Both actions are
                      route-scoped — each returns null off its own detail routes.
                      Its own Suspense with a NULL fallback: the badge is lazy, and
                      a shared boundary would let its chunk load blank the Topbar
                      (breadcrumbs included) on first navigation to a session. A
                      disclosure that is not there yet shows nothing, which is also
                      the honest state while the read it describes is in flight. */}
                      <Suspense fallback={null}>
                        <SessionReadSourceTopbarAction
                          sessionId={detailSessionId}
                        />
                      </Suspense>
                      <Suspense fallback={null}>
                        <DetailCommentsTopbarAction
                          branchCommentsControl={branchCommentsControl}
                          branchId={detailBranchId}
                          sessionId={detailSessionId}
                        />
                      </Suspense>
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
                {/* FEA-4007: app-level opt-in install prompt. Mounted here (not inside
              the Labs-gated Agents view) so a targeted user is prompted for an
              org-distributed opt-in install on startup regardless of the Agents
              Workspace flag or the current tab. Operator instruction 2026-09-30:
              gated behind `distribution-opt-in-banner`, default OFF, read inside
              the banner so its one-shot push subscription survives a PENDING
              assignment. */}
                <OptInDistributionsBanner />
                <div
                  className={contentViewportClassName}
                  data-testid="desktop-content-viewport"
                  onScroll={handleContentViewportScroll}
                  ref={contentViewportRef}
                >
                  {content}
                </div>
                <DesktopSettingsModalHost
                  requestedNavId={requestedNavId}
                  returnHref={settingsReturnHref}
                />
              </SidebarInset>
            </>
          )}
        </AnalysisBannerOffsetProvider>
      </InviteSpotlightProvider>
    </SidebarProvider>
  );
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
 * ISS-5310 (whitlockk cid 3726730878, stage cid 3726701517) — the Agents DETAIL
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
  outcome,
}: {
  agentSlug: string;
  agentsListHref: string;
  outcome: LabsPageOutcome;
}): ReactNode {
  if (outcome !== LabsPageOutcome.Render) {
    return labsGatedPage(outcome, NavId.Agents);
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

/**
 * ISS-7249 (whitlockk review): whether the keep-alive nav map is the body the user
 * is looking at. `active` alone is NOT "on screen" — a detail route replaces
 * `content` wholesale while the nav map underneath stays mounted, and on a
 * detail route `routeNavId` is null, so the originating list still reads as the
 * active nav id. A page that reports what its own body is showing needs both.
 */
function isNavMapVisible({
  projectRoute,
  detailDocumentSlug,
  detailAgentSlug,
  detailBranchId,
  detailSessionId,
}: {
  projectRoute?: ReturnType<typeof matchRoute>;
  detailAgentSlug: string | null;
  detailBranchId: string | null;
  detailSessionId: string | null;
  detailDocumentSlug: string | null;
}): boolean {
  return !(
    projectRoute?.kind === "project-context" ||
    detailSessionId ||
    detailBranchId ||
    detailAgentSlug ||
    detailDocumentSlug
  );
}

function documentDetailContent({
  slug,
  labsItemGates,
  labsNavOn,
  desktopFlagsResolved,
}: {
  slug: string;
  labsItemGates: Readonly<Record<string, boolean>>;
  labsNavOn: boolean;
  desktopFlagsResolved: boolean;
}) {
  const pageId = NavId.Documents;
  const outcome = resolveLabsPageOutcome({
    pageId,
    active: true,
    labsItemOn: resolveLabsItemGate({ labsItemGates, pageId }),
    labsNavOn,
    desktopFlagsResolved,
  });
  if (outcome !== LabsPageOutcome.Render) {
    return labsGatedPage(outcome, pageId);
  }
  return (
    <Suspense fallback={<PageFallback />}>
      <DesktopDocumentDetailView key={slug} slug={slug} />
    </Suspense>
  );
}

function projectContextContent(
  route: Extract<
    NonNullable<ReturnType<typeof matchRoute>>,
    { kind: "project-context" }
  >
): ReactNode {
  const key = route.projectId ?? `${route.teamId}:${route.archived}`;
  return (
    <Suspense fallback={<PageFallback />}>
      <ProjectContextView
        archived={route.archived}
        key={key}
        projectId={route.projectId}
        teamId={route.teamId}
      />
    </Suspense>
  );
}

function projectRouteContext(route: ReturnType<typeof matchRoute>) {
  if (route?.kind === "project-context") {
    return route;
  }
  return undefined;
}

/**
 * The shell body for the current route: a detail tier when one matches, in the
 * order project-context → session → branch → document → agent, else the
 * keep-alive nav map.
 */
function selectRouteContent({
  route,
  keepAliveContent,
  detailSessionId,
  detailBranchId,
  detailAgentSlug,
  sessionsListHref,
  branchBackHref,
  branchBackLabel,
  branchCommentsControl,
  agentsListHref,
  agentDetailOutcome,
  labsItemGates,
  labsNavOn,
  desktopFlagsResolved,
}: {
  route: ReturnType<typeof matchRoute>;
  keepAliveContent: ReactNode;
  detailSessionId: string | null;
  detailBranchId: string | null;
  detailAgentSlug: string | null;
  sessionsListHref: string;
  branchBackHref: string;
  branchBackLabel: ReturnType<typeof resolveBranchBackLabel>;
  branchCommentsControl: ReturnType<typeof useBranchCommentsControl>;
  agentsListHref: string;
  agentDetailOutcome: LabsPageOutcome;
  labsItemGates: Readonly<Record<string, boolean>>;
  labsNavOn: boolean;
  desktopFlagsResolved: boolean;
}): ReactNode {
  if (route?.kind === "project-context") {
    return projectContextContent(route);
  }
  if (detailSessionId) {
    return (
      <Suspense fallback={detailFallbackFor(DetailFallbackKind.Session)}>
        {/* The COERCED href, not the raw `sessionBackHref`: this prop feeds only
            the not-found and provider-error states, whose sole control is a link
            that says "Back to Sessions". `sessionBackHref` is the last nav route
            of ANY section, so a detail reached from another surface aimed that
            link at that surface instead — with Dashboard as the landing, "Back to
            Sessions" navigated to /dashboard. `sessionsListHref` keeps the
            originating sessions query (page, filters) when there is one and falls
            back to the canonical list when there is not, so the label and the
            destination always agree. */}
        <SessionDetailView
          backHref={sessionsListHref}
          key={detailSessionId}
          sessionId={detailSessionId}
        />
      </Suspense>
    );
  }
  if (detailBranchId) {
    return (
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
  }
  if (route?.kind === "document-detail") {
    return documentDetailContent({
      slug: route.slug,
      labsItemGates,
      labsNavOn,
      desktopFlagsResolved,
    });
  }
  if (detailAgentSlug) {
    return agentDetailContent({
      agentSlug: detailAgentSlug,
      agentsListHref,
      outcome: agentDetailOutcome,
    });
  }
  return keepAliveContent;
}
