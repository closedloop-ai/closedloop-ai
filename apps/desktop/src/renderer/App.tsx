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
  useRef,
  useState,
} from "react";
import { MacWindowControlsUnderlay } from "./components/layout/mac-window-controls-underlay";
import { Sidebar } from "./components/layout/Sidebar";
import { Topbar } from "./components/layout/Topbar";
import { UpdateBanner } from "./components/UpdateBanner";
import { DesktopFeatureFlagProvider } from "./feature-flags/desktop-feature-flag-provider";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "./navigation/desktop-adapter";
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
const KanbanView = lazy(() =>
  import("./components/kanban/KanbanView").then((m) => ({
    default: m.KanbanView,
  }))
);
const ActivityFeedView = lazy(() =>
  import("./components/feed/ActivityFeedView").then((m) => ({
    default: m.ActivityFeedView,
  }))
);
const InsightsView = lazy(() =>
  import("./components/insights/insights-view").then((m) => ({
    default: m.InsightsView,
  }))
);
const WorkflowsView = lazy(() =>
  import("./components/derived/desktop-derived-telemetry-view").then((m) => ({
    default: m.WorkflowsView,
  }))
);
const PacksView = lazy(() =>
  import("./components/features/CoreFeaturesView").then((m) => ({
    default: m.PacksView,
  }))
);
const SkillsView = lazy(() =>
  import("./components/features/CoreFeaturesView").then((m) => ({
    default: m.SkillsView,
  }))
);
const ToolsView = lazy(() =>
  import("./components/derived/desktop-derived-telemetry-view").then((m) => ({
    default: m.ToolsView,
  }))
);
const SubAgentsView = lazy(() =>
  import("./components/derived/desktop-derived-telemetry-view").then((m) => ({
    default: m.SubAgentsView,
  }))
);
const PlansView = lazy(() =>
  import("./components/features/CoreFeaturesView").then((m) => ({
    default: m.PlansView,
  }))
);
const PullRequestsView = lazy(() =>
  import("./components/features/CoreFeaturesView").then((m) => ({
    default: m.PullRequestsView,
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

const KeepAliveExcludedNavIds = new Set<NavId>([
  NavId.Insights,
  NavId.Workflows,
  NavId.Tools,
  NavId.Subagents,
]);
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
        <AppShell navigation={navigation} />
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

  // Keep-alive: views stay mounted (hidden) once visited so tab switches
  // do not refetch. Same render-phase guarded-update pattern as above.
  const [visitedNavIds, setVisitedNavIds] = useState<NavId[]>([deferredNavId]);
  if (!visitedNavIds.includes(deferredNavId)) {
    setVisitedNavIds([...visitedNavIds, deferredNavId]);
  }

  const [runtimeStatus, setRuntimeStatus] = useState<Record<
    string,
    unknown
  > | null>(null);

  useEffect(() => {
    window.desktopApi
      .getRuntimeStatus()
      .then((s) => setRuntimeStatus(s as Record<string, unknown>))
      .catch(() => {});
  }, []);

  // IPC bridge: the main process (menu items, tray, deep links) sends
  // desktop:navigate-tab via preload; translate it into port navigation.
  useEffect(() => {
    const handler = (e: CustomEvent<string>) => {
      navigate(hrefForNavId(normalizeNavId(e.detail)));
    };
    window.addEventListener("desktop:navigate-tab", handler as EventListener);
    return () =>
      window.removeEventListener(
        "desktop:navigate-tab",
        handler as EventListener
      );
  }, [navigate]);

  const healthy = runtimeStatus?.gatewayHealthy === true;
  const handleSidebarOpenChange = useCallback((open: boolean) => {
    setSidebarOpen(open);
    writeDesktopSidebarOpen(open);
  }, []);

  const renderPage = useCallback((pageId: NavId, active: boolean) => {
    switch (pageId) {
      case NavId.Sessions:
        return <SessionsView />;
      case NavId.Dashboard:
        return <DashboardPage />;
      case NavId.Branches:
        return <BranchesView />;
      case NavId.Kanban:
        return <KanbanView />;
      case NavId.Activity:
        return <ActivityFeedView />;
      case NavId.Insights:
        return <InsightsView />;
      case NavId.Workflows:
        return <WorkflowsView />;
      case NavId.Packs:
        return <PacksView />;
      case NavId.Skills:
        return <SkillsView />;
      case NavId.Tools:
        return <ToolsView />;
      case NavId.Subagents:
        return <SubAgentsView />;
      case NavId.Plans:
        return <PlansView />;
      case NavId.PullRequests:
        return <PullRequestsView />;
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
  let content = (
    <Suspense fallback={<PageFallback />}>
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
  }

  const contentViewportClassName = deferredSessionId
    ? "flex min-h-0 flex-1 flex-col overflow-hidden"
    : "flex-1 overflow-auto";

  return (
    <SidebarProvider
      className="h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]"
      onOpenChange={handleSidebarOpenChange}
      open={sidebarOpen}
    >
      <MacWindowControlsUnderlay />
      <Sidebar activeNav={navId} runtimeHealthy={healthy} />
      <SidebarInset className="min-w-0 overflow-hidden">
        <Topbar navId={navId} />
        <UpdateBanner />
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
