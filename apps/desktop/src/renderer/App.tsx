import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  SidebarInset,
  SidebarProvider,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import { parsePath } from "@repo/navigation/href-store";
import { NavigationProvider } from "@repo/navigation/provider";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BranchesLoading } from "./components/branches/branches-loading";
import { DashboardFallback } from "./components/dashboard/dashboard-fallback";
import { DesktopSessionExpiredBanner } from "./components/desktop-session-expired-banner";
import { FirstLaunchImportBanner } from "./components/first-launch-import-banner";
import { MacWindowControlsUnderlay } from "./components/layout/mac-window-controls-underlay";
import { Sidebar } from "./components/layout/Sidebar";
import { Topbar, type TopbarBreadcrumb } from "./components/layout/Topbar";
import { UpdateBanner } from "./components/UpdateBanner";
import { DesktopFeatureFlagProvider } from "./feature-flags/desktop-feature-flag-provider";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "./navigation/desktop-adapter";
import {
  DetailTitleProvider,
  detailTitleKey,
  resolveDetailTitle,
  useDetailTitle,
} from "./navigation/detail-title-context";
import {
  NAV_SECTION_LABELS,
  navEntryFor,
  navSectionFor,
} from "./navigation/nav-config";
import {
  DEFAULT_NAV_ID,
  hrefForNavId,
  matchRoute,
  NavId,
  normalizeNavId,
} from "./navigation/route-table";

const DashboardPage = lazy(() =>
  import("./components/dashboard/DashboardPage").then((m) => ({
    default: m.DashboardPage,
  }))
);
const SettingsPanel = lazy(() =>
  import("./components/settings/SettingsPanel").then((m) => ({
    default: m.SettingsPanel,
  }))
);
const BranchesView = lazy(() =>
  import("./components/branches/branches-view").then((m) => ({
    default: m.BranchesView,
  }))
);
const InsightsView = lazy(() =>
  import("./components/insights/insights-view").then((m) => ({
    default: m.InsightsView,
  }))
);
const PlansView = lazy(() =>
  import("./components/features/CoreFeaturesView").then((m) => ({
    default: m.PlansView,
  }))
);
const ApprovalsPanel = lazy(() =>
  import("./components/approvals/ApprovalsPanel").then((m) => ({
    default: m.ApprovalsPanel,
  }))
);
const ActivityPanel = lazy(() =>
  import("./components/activity/ActivityPanel").then((m) => ({
    default: m.ActivityPanel,
  }))
);
const DiagnosticsView = lazy(() =>
  import("./components/diagnostics/diagnostics-view").then((m) => ({
    default: m.DiagnosticsView,
  }))
);
const SessionsView = lazy(() =>
  import("./components/sessions/SessionsView").then((m) => ({
    default: m.SessionsView,
  }))
);
const SessionDetailView = lazy(() =>
  import("./components/sessions/SessionDetailView").then((m) => ({
    default: m.SessionDetailView,
  }))
);
const BranchDetailView = lazy(() =>
  import("./components/branches/branch-detail-view").then((m) => ({
    default: m.BranchDetailView,
  }))
);
const AgentsView = lazy(() =>
  import("./components/agents/agents-view").then((m) => ({
    default: m.AgentsView,
  }))
);
const AgentDetailView = lazy(() =>
  import("./components/agents/agent-detail-view").then((m) => ({
    default: m.AgentDetailView,
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

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[var(--muted-foreground)] text-sm">Loading...</p>
    </div>
  );
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
          <AppShell navigation={navigation} />
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
  const navId = routeNavId ?? lastNavId;
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

  // Deferred values keep the previous view on screen while a lazily-loaded
  // chunk resolves (the pre-port code got this from startTransition around
  // setState; useSyncExternalStore updates cannot be transitions).
  const deferredNavId = useDeferredValue(navId);
  const deferredSessionId = useDeferredValue(detailSessionId);
  const deferredBranchId = useDeferredValue(detailBranchId);
  const deferredAgentSlug = useDeferredValue(detailAgentSlug);

  // The open detail page (if any) publishes its name through this context; the
  // Topbar breadcrumb shows it as the trailing "> [name]" segment. The published
  // title is keyed to its detail and only used when that key matches the detail
  // currently shown — the deferred ids can flip to a different detail a commit
  // before the publishing effect settles, so an unmatched title would otherwise
  // flash the previous detail's name under the new list for one frame.
  const publishedDetail = useDetailTitle();
  const detailTitle = resolveDetailTitle(
    publishedDetail,
    activeDetailTitleKey(deferredSessionId, deferredBranchId, deferredAgentSlug)
  );

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

  // The shared "agents" PostHog flag can't resolve in the packaged desktop
  // renderer (no PostHog wiring yet). It is registered in the desktop flag
  // registry so users can opt in via the Labs settings panel (FEA-2923).
  const agentsFlagOn = useFeatureFlagEnabled(AGENTS_FEATURE_FLAG_KEY);
  const hiddenNavIds = useMemo<NavId[]>(
    () => (agentsFlagOn ? [] : [NavId.Agents]),
    [agentsFlagOn]
  );

  const renderPage = useCallback((pageId: NavId, active: boolean) => {
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
      case NavId.Settings:
        return <SettingsPanel />;
      default:
        return <SessionsView />;
    }
  }, []);

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

  // Breadcrumb model (mirrors the web app's per-page `breadcrumbs` prop): detail
  // pages render "<List> / <name>" with the list segment linking back to its
  // list, and list pages render their nav section + label. Keyed off the
  // deferred detail ids so the breadcrumb switches in lockstep with the visible
  // content.
  const breadcrumbs = buildBreadcrumbs({
    deferredSessionId,
    deferredBranchId,
    deferredAgentSlug,
    detailTitle,
    navId,
    sessionsListHref,
  });

  let content = (
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
  if (deferredSessionId) {
    content = (
      <Suspense fallback={<PageFallback />}>
        <SessionDetailView
          backHref={sessionBackHref}
          sessionId={deferredSessionId}
        />
      </Suspense>
    );
  } else if (deferredBranchId) {
    content = (
      <Suspense fallback={<PageFallback />}>
        {/* Branch detail always belongs under the Branches list, so Back targets
            it explicitly — not the contextual `navId`, which on a direct
            #/branches/:id load (or arrival from another section) would point
            "Back to Branches" at Sessions. */}
        <BranchDetailView
          backHref={hrefForNavId(NavId.Branches)}
          branchId={deferredBranchId}
        />
      </Suspense>
    );
  } else if (deferredAgentSlug) {
    content = (
      <Suspense fallback={<PageFallback />}>
        {/* Agent detail always belongs under the Agents list, so Back targets
            it explicitly — not the contextual `navId`, which on a direct
            #/agents/:id load (or arrival from another section) would point
            "Back to Agents" at Sessions. */}
        <AgentDetailView
          agentSlug={deferredAgentSlug}
          backHref={hrefForNavId(NavId.Agents)}
        />
      </Suspense>
    );
  }

  // Session AND branch detail own their own internal scroll container (the
  // single `.sd3-scroll` / `.bq-page-scroll`), so the outer viewport must clip
  // and hand height down rather than scroll itself — otherwise the inner
  // `position: sticky` header never pins and the trace can't virtualize against
  // the page scroller. Every other route lets this viewport be the scroller.
  const contentViewportClassName =
    deferredSessionId || deferredBranchId || deferredAgentSlug
      ? "flex min-h-0 flex-1 flex-col overflow-hidden"
      : "flex-1 overflow-auto";

  return (
    <SidebarProvider
      className="h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]"
      onOpenChange={handleSidebarOpenChange}
      open={sidebarOpen}
    >
      <MacWindowControlsUnderlay />
      <Sidebar activeNav={navId} hiddenNavIds={hiddenNavIds} />
      <SidebarInset className="min-w-0 overflow-hidden">
        <Topbar breadcrumbs={breadcrumbs} />
        <UpdateBanner />
        <DesktopSessionExpiredBanner />
        <FirstLaunchImportBanner />
        <div
          className={contentViewportClassName}
          data-testid="desktop-content-viewport"
          onScroll={handleContentViewportScroll}
          ref={contentViewportRef}
        >
          {content}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * The `detailTitleKey()` of the detail currently shown (session takes
 * precedence, matching the content render order), or null on a list page. Used
 * to confirm a published breadcrumb title belongs to the shown detail.
 */
function activeDetailTitleKey(
  deferredSessionId: string | null,
  deferredBranchId: string | null,
  deferredAgentSlug: string | null
): string | null {
  if (deferredSessionId) {
    return detailTitleKey("session", deferredSessionId);
  }
  if (deferredBranchId) {
    return detailTitleKey("branch", deferredBranchId);
  }
  if (deferredAgentSlug) {
    // Use a raw string key to avoid extending the DetailKind type in
    // detail-title-context. The format mirrors detailTitleKey() convention.
    return `agent:${deferredAgentSlug}`;
  }
  return null;
}

/**
 * The href the breadcrumb's "Sessions" parent links to: the originating sessions
 * list (with its page/filter query) when the detail was opened from a sessions
 * route, else the canonical list. Guarding on the route kind keeps the "Sessions"
 * label from pointing at another section when the detail was reached from there.
 */
function sessionsBreadcrumbHref(sessionBackHref: string): string {
  const match = matchRoute(parsePath(sessionBackHref));
  return match?.kind === "nav" && match.navId === NavId.Sessions
    ? sessionBackHref
    : hrefForNavId(NavId.Sessions);
}

/**
 * Builds the Topbar breadcrumb segments. Detail pages get a two-segment
 * "<List> / <name>" trail whose list segment links back to its list, with a
 * generic fallback name until the detail data resolves. List pages get their
 * nav section (when one is shown) plus the page label, preserving the prior
 * Topbar behavior.
 */
function buildBreadcrumbs({
  deferredSessionId,
  deferredBranchId,
  deferredAgentSlug,
  detailTitle,
  navId,
  sessionsListHref,
}: {
  deferredSessionId: string | null;
  deferredBranchId: string | null;
  deferredAgentSlug: string | null;
  detailTitle: string | null;
  navId: NavId;
  sessionsListHref: string;
}): TopbarBreadcrumb[] {
  if (deferredSessionId) {
    return [
      {
        label: navEntryFor(NavId.Sessions)?.label ?? "Sessions",
        href: sessionsListHref,
      },
      { label: detailTitle ?? "Session" },
    ];
  }
  if (deferredBranchId) {
    return [
      {
        label: navEntryFor(NavId.Branches)?.label ?? "Branches",
        href: hrefForNavId(NavId.Branches),
      },
      { label: detailTitle ?? "Branch" },
    ];
  }
  if (deferredAgentSlug) {
    return [
      {
        label: navEntryFor(NavId.Agents)?.label ?? "Agents",
        href: hrefForNavId(NavId.Agents),
      },
      { label: detailTitle ?? "Component" },
    ];
  }
  const entry = navEntryFor(navId);
  const section = navSectionFor(navId);
  const sectionLabel = section ? NAV_SECTION_LABELS[section] : null;
  const crumbs: TopbarBreadcrumb[] = [];
  if (sectionLabel) {
    crumbs.push({ label: sectionLabel });
  }
  crumbs.push({ label: entry?.label ?? navId });
  return crumbs;
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

function lastNavHrefFromHistory(
  history: readonly string[],
  fallbackNavId: NavId
): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const href = history[i];
    const match = matchRoute(parsePath(href));
    if (match?.kind === "nav") {
      return href;
    }
  }
  return hrefForNavId(fallbackNavId);
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
  if (globalThis.window === undefined) {
    return true;
  }
  try {
    return (
      globalThis.window.localStorage.getItem(
        DESKTOP_SIDEBAR_OPEN_STORAGE_KEY
      ) !== "false"
    );
  } catch {
    return true;
  }
}

/**
 * Persists the Desktop renderer-only sidebar preference when localStorage is
 * available. Callers update React state first so write failures do not block UI.
 */
function writeDesktopSidebarOpen(open: boolean): void {
  if (globalThis.window === undefined) {
    return;
  }
  try {
    globalThis.window.localStorage.setItem(
      DESKTOP_SIDEBAR_OPEN_STORAGE_KEY,
      open ? "true" : "false"
    );
  } catch {
    // localStorage can be disabled or quota-denied; the in-memory UI state wins.
  }
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
