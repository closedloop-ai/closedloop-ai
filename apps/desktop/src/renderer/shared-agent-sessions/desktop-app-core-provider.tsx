import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { createHttpAgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { createHttpAgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsLiveBridge } from "@repo/app/agents/data-source/agent-sessions-live-bridge";
import {
  AgentComponentsDataSourceProvider,
  AgentSessionsDataSourceProvider,
} from "@repo/app/agents/data-source/provider";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import {
  createHttpTraceCommentsDataSource,
  type TraceCommentsDataSource,
} from "@repo/app/shared/trace-comments/trace-comments-data-source";
import { TraceCommentsDataSourceProvider } from "@repo/app/shared/trace-comments/trace-comments-provider";
import { registerSurfaceRoutingAdapter } from "@repo/shared-platform/gateway-dispatch";
import { installGatewayFetchShim } from "@repo/shared-platform/gateway-fetch-shim";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  createDesktopRoutingAdapter,
  ensureDesktopRoutingSelection,
} from "../engineer/desktop-routing-adapter";
import { DesktopBranchesConsumptionProvider } from "../shared-branches/desktop-branches-consumption";
import { createDesktopTraceCommentsDataSource } from "../shared-trace-comments/desktop-trace-comments-data-source";
import { createDesktopCloudApiAdapter } from "./cloud-api-adapter";
import {
  CloudReadCutoverBlocker,
  type CloudReadCutoverDecision,
  CloudReadCutoverLatch,
  DesktopAppCoreMode,
} from "./desktop-app-core-mode";
import { DesktopAuthProvider, useDesktopAuth } from "./desktop-auth-provider";
import { DesktopParsingBugFlagProvider } from "./desktop-parsing-bug-flag-provider";
import { DesktopTranscriptTransportProvider } from "./desktop-transcript-transport";
import { InsightsLiveBridge } from "./insights-live-bridge";
import { createLocalAgentComponentsDataSource } from "./local-agent-components-data-source";
import { createLocalAgentSessionsDataSource } from "./local-agent-sessions-data-source";
import { applyDesktopSessionsListPollDefaults } from "./sessions-list-poll-defaults";
import { useCloudReadCutover } from "./use-cloud-read-cutover";
import { useOnlineStatus } from "./use-online-status";

const DesktopAppCoreModeContext = createContext<DesktopAppCoreMode>(
  DesktopAppCoreMode.Local
);

/**
 * The read-source decision outside a mounted provider: local, because nobody is
 * signed in. Matches {@link DesktopAppCoreModeContext}'s `Local` default so a
 * view rendered in a test/story wrapper sees one consistent story.
 */
const UNMOUNTED_CLOUD_READ_CUTOVER: CloudReadCutoverDecision = {
  mode: DesktopAppCoreMode.Local,
  blocker: CloudReadCutoverBlocker.NotAuthenticated,
  failedOpen: false,
  latch: CloudReadCutoverLatch.None,
  itemsRemaining: null,
  deadLetteredCount: 0,
  cloudHoldsHistory: false,
};

const DesktopCloudReadCutoverContext = createContext<CloudReadCutoverDecision>(
  UNMOUNTED_CLOUD_READ_CUTOVER
);

/**
 * The active app-core mode (PLN-1138 D-E), for surfaces that select their own
 * read source outside this stack — the desktop Branches views, which
 * self-provide a `BranchesDataSource` per view (see `DesktopBranchesSource`).
 * Defaults to `Local` when no provider is mounted, so a view rendered outside
 * the app-core provider (test/story wrappers) keeps the local behavior.
 */
export function useDesktopAppCoreMode(): DesktopAppCoreMode {
  return useContext(DesktopAppCoreModeContext);
}

/**
 * ISS-5477: WHY the active read source is what it is — the backlog condition
 * still blocking the cutover, whether the bounded fail-open let the reader
 * through anyway, and how much work is still local or abandoned.
 *
 * Surfaces that already tell the user which source they are reading (the
 * read-source badge) consume this to say why, rather than a parallel indicator
 * growing beside them.
 */
export function useDesktopCloudReadCutover(): CloudReadCutoverDecision {
  return useContext(DesktopCloudReadCutoverContext);
}

/**
 * Desktop app-core provider stack for shared `@repo/app` telemetry views.
 *
 * `DesktopAuthProvider` (FEA-2219) sits at the root — above the rest of the
 * stack — because the live auth state it mirrors from the main-process session
 * manager is (with connectivity and, since ISS-5477, sync readiness) what
 *selects* the stack (PLN-1138 D-E). See `resolveCloudReadCutover`: a renderer
 * runs the cloud stack once it is authenticated, online, AND the local→cloud
 * backlog has drained; every other state runs local. {@link DesktopAppCoreModeStack}
 * rebuilds the stack as one unit per mode, so the app never observes a
 * half-configured stack and login / logout / connectivity flip it at runtime
 * with no reload.
 *
 * `ApiAdapterProvider` carries the cloud transport (PLN-1138 D-G Option B):
 * `createDesktopCloudApiAdapter` marshals cloud REST requests over IPC to the
 * main process, which resolves the API origin and attaches the first-party
 * session token (signed-out requests short-circuit to 401 in main). The
 * credential never enters renderer JS — the auth port surfaces only a sentinel.
 *
 * **Sessions source selection (Phase 2, this file's job):** the Sessions views
 * read the org cloud API (the shared HTTP source, scope `"http"`, over the D-G
 * bridge) when authenticated + online, and the local SQLite source (scope
 * `"local"`, over IPC) otherwise. The `scope`-keyed React Query keys plus the
 * per-mode QueryClient keep the two sets isolated — no row ever crosses modes
 * (AC-3.1). See {@link DesktopSessionsViewSource}.
 *
 * **Agent-components source selection (FEA-3459):** like Sessions, the
 * agent-components workspace reads the org cloud API (the shared HTTP source,
 * scope `"agent-components:http"`) when authenticated + online, and the local
 * SQLite source (scope `"agent-components:local"`) otherwise — so Cloud mode
 * shows the org-wide deduped inventory with owner/collaborators/cohort metrics/
 * branches/multi-device provenance populated, not just this machine's local
 * components. See {@link DesktopAgentComponentsViewSource}.
 *
 * **Trace comments source selection (FEA-3460 / FEA-3522):** like Sessions and
 * agent-components, in Cloud mode the trace-comment views read from — and now
 * write to — the org cloud API (the shared HTTP source, scope `"http"`, over the
 * D-G bridge). FEA-3460 could only route *reads* over the bridge because it was
 * GET-only; FEA-3522's authenticated write transport (`cloud-api-fetch-ipc.ts`,
 * `WRITE_ALLOWLIST`) lets create / reply / update / delete land on the org too,
 * so the former cloud-reads / local-writes composite is gone. Every other state
 * (signed out / offline) stays fully local (scope `"desktop-local"`), and the
 * local SQLite store keeps its own cloud-sync push, so no local comment is lost.
 * See {@link DesktopTraceCommentsViewSource}.
 *
 * **Still local in both modes (until later phases):** the
 * Dashboard insights aggregates. `InsightsLiveBridge` therefore stays mounted in
 * both modes, riding the local DB's `desktop:db:changed` push (FEA-1834) — it is
 * the *outer* (local) sessions source that feeds it, deliberately, so migrating
 * the Sessions *views* to cloud does not silence the insights push. Phase 3
 * migrates insights and drops this arrangement.
 */
export function DesktopAppCoreProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  // Engineer gateway transport (M-001): install the shared `/api/gateway/*`
  // fetch shim, register the desktop SurfaceRoutingAdapter the shared router
  // dispatches to, and repair the routing selection to LocalElectron (the
  // shared default is CloudRelay, which the desktop adapter does not support in
  // v1). Ref-counted shim + Set-backed registry + idempotent repair keep this
  // correct under React Strict Mode's mount → unmount → remount cycle.
  //
  // Unlike the web bootstrap (which guards on `shim.isFirstInstall` because
  // `installEngineerFetchInterceptor` is a global, multi-caller install keyed on
  // window state), this is the single app-core mount: each effect run registers
  // exactly one adapter and the cleanup disposes that same instance, so an
  // unconditional register/dispose pair is the idiomatic, leak-free shape here.
  //
  // Mode-independent: the Engineer gateway is localhost command execution, never
  // a cloud read path (PLN-1138 D-F), so it is installed once above the stack
  // rather than rebuilt per mode.
  useEffect(() => {
    const shim = installGatewayFetchShim();
    const disposeAdapter = registerSurfaceRoutingAdapter(
      createDesktopRoutingAdapter()
    );
    ensureDesktopRoutingSelection();
    return () => {
      disposeAdapter();
      shim.dispose();
    };
  }, []);

  return (
    <DesktopAuthProvider>
      <DesktopTranscriptTransportProvider>
        <DesktopAppCoreModeStack>{children}</DesktopAppCoreModeStack>
      </DesktopTranscriptTransportProvider>
    </DesktopAuthProvider>
  );
}

/** Every port the app-core stack injects, built as one unit per mode. */
type DesktopAppCoreStack = {
  mode: DesktopAppCoreMode;
  queryClient: QueryClient;
  featureFlagAdapter: FeatureFlagAdapter;
  apiAdapter: ApiAdapter;
  /**
   * The local SQLite agent-components source (scope `"agent-components:local"`).
   * Always built as the outer/default source; the workspace *views* override it
   * with the cloud HTTP source in cloud mode via {@link DesktopAgentComponentsViewSource}.
   */
  localAgentComponentsDataSource: AgentComponentsDataSource;
  /**
   * The local SQLite sessions source (scope `"local"`). Always built: it is the
   * outer sessions context, so it drives the local push bridges (Sessions in
   * local mode, insights in both modes) even when the Sessions *views* are
   * overridden to the cloud HTTP source in cloud mode.
   */
  localAgentSessionsDataSource: AgentSessionsDataSource;
  /**
   * The local SQLite trace-comments source (scope `"desktop-local"`). Always
   * built; the views are overridden to the cloud HTTP source in cloud mode
   * (FEA-3460), while the local source stays the write target when signed out /
   * offline.
   */
  localTraceCommentsDataSource: TraceCommentsDataSource;
};

/**
 * Selects and mounts the app-core stack for the current mode (PLN-1138 D-E).
 *
 * The mode is derived from live auth state + connectivity, and the QueryClient
 * (hence the cache) is rebuilt when it changes, so rows read in one mode are
 * never observable in the other (AC-3.1) — the `scope`-keyed query keys then
 * reinforce that within a client. Login, logout, and connectivity transitions
 * flip the active stack at runtime with no reload.
 *
 * The stack is rebuilt during render, keyed on mode, rather than by remounting a
 * `key`ed subtree: a key change here would unmount the entire app below
 * `children` — discarding navigation, scroll, and component state on every
 * sign-in — while swapping the provider *values* flips the ports just as
 * atomically. (Cost, accepted per plan: a `navigator.onLine` flap rebuilds the
 * client and drops the cache; connectivity is coarse, and regaining it refetches
 * from empty anyway.)
 */
function DesktopAppCoreModeStack({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { state } = useDesktopAuth();
  const isOnline = useOnlineStatus();
  // ISS-5477: authentication alone no longer moves the read source. The cutover
  // additionally requires the parse/import backlog to be complete and every
  // desktop→cloud sync lane to report `drained` — otherwise the cloud would be
  // read before it has received anything and the user's history would appear to
  // vanish at the moment they signed in.
  //
  // ISS-5714 (review thread): the WHOLE auth identity goes in, not just the
  // status. Token application can switch straight from authenticated org A to
  // authenticated org B, and a status-only hook would hand B the drained latch A
  // earned — see `cloudReadCutoverIdentityKey`.
  const cutover = useCloudReadCutover({
    isOnline,
    organizationId: state.organizationId,
    status: state.status,
    userId: state.userId,
  });
  const mode = cutover.mode;
  const stack = useDesktopAppCoreStack(mode);

  return (
    <DesktopCloudReadCutoverContext.Provider value={cutover}>
      <DesktopAppCoreModeContext.Provider value={mode}>
        {/* ISS-5714: the Branch-only consumption context is mounted INSIDE the
            cutover context (it used to sit above this stack) so Branches reads
            its cloud-eligibility from the SAME decision Sessions does, instead
            of re-deriving one from auth state alone. Nothing between the old
            and new position consumes it, and this component never remounts, so
            the Branch QueryClient still survives every mode transition. */}
        <DesktopBranchesConsumptionProvider
          cloudHoldsHistory={cutover.cloudHoldsHistory}
        >
          <QueryClientProvider client={stack.queryClient}>
            <FeatureFlagAdapterProvider adapter={stack.featureFlagAdapter}>
              <ApiAdapterProvider adapter={stack.apiAdapter}>
                <DesktopAgentComponentsViewSource
                  localSource={stack.localAgentComponentsDataSource}
                  mode={stack.mode}
                >
                  <DesktopTraceCommentsViewSource
                    localSource={stack.localTraceCommentsDataSource}
                    mode={stack.mode}
                  >
                    <AgentSessionsDataSourceProvider
                      dataSource={stack.localAgentSessionsDataSource}
                    >
                      {/* Insights stay local in both modes (Phase 3 migrates them);
                    the outer local source above feeds their push stream. */}
                      <InsightsLiveBridge />
                      {/* Local push for the Sessions views, local mode only: in cloud
                    mode the views read HTTP, so local DB changes are irrelevant
                    to them. A `null` slot (not an absent child) keeps the source
                    layer below at a stable position across mode swaps. */}
                      {stack.mode === DesktopAppCoreMode.Local ? (
                        <AgentSessionsLiveBridge />
                      ) : null}
                      <DesktopSessionsViewSource
                        localSource={stack.localAgentSessionsDataSource}
                        mode={stack.mode}
                      >
                        <DesktopParsingBugFlagProvider>
                          {children}
                        </DesktopParsingBugFlagProvider>
                      </DesktopSessionsViewSource>
                    </AgentSessionsDataSourceProvider>
                  </DesktopTraceCommentsViewSource>
                </DesktopAgentComponentsViewSource>
              </ApiAdapterProvider>
            </FeatureFlagAdapterProvider>
          </QueryClientProvider>
        </DesktopBranchesConsumptionProvider>
      </DesktopAppCoreModeContext.Provider>
    </DesktopCloudReadCutoverContext.Provider>
  );
}

/**
 * Selects the Sessions read source for the *views* (PLN-1138 D-E / Phase 2).
 *
 * - **Cloud mode:** the shared HTTP source (scope `"http"`) so the views read
 *   the org cloud API over the D-G bridge, server sorted + paginated.
 * - **Local mode:** the local SQLite source (scope `"local"`) — the same
 *   instance the outer provider already holds; its `desktop:db:changed` push is
 *   driven by the `AgentSessionsLiveBridge` mounted above.
 *
 * Always an inner `AgentSessionsDataSourceProvider` with only its *value*
 * swapped, so `children` (the mounted views) keep their position and local UI
 * state across a mode flip — a transient `navigator.onLine` blip must not
 * unmount the Sessions page. The `scope`-keyed cache still isolates the two row
 * sets, and the per-mode QueryClient swap drops the previous mode's data.
 *
 * `useApiClient()` is called unconditionally (Rules of Hooks); the HTTP source
 * is only constructed when the mode actually selects it.
 */
function DesktopSessionsViewSource({
  mode,
  localSource,
  children,
}: Readonly<{
  mode: DesktopAppCoreMode;
  localSource: AgentSessionsDataSource;
  children: ReactNode;
}>) {
  const apiClient = useApiClient();
  const source = useMemo(
    () =>
      mode === DesktopAppCoreMode.Cloud
        ? createHttpAgentSessionsDataSource(apiClient)
        : localSource,
    [mode, apiClient, localSource]
  );
  return (
    <AgentSessionsDataSourceProvider dataSource={source}>
      {children}
    </AgentSessionsDataSourceProvider>
  );
}

/**
 * Selects the agent-components read source for the workspace (FEA-3459).
 *
 * - **Cloud mode:** the shared HTTP source (scope `"agent-components:http"`) so
 *   the workspace reads the org-wide, server-deduped inventory over the D-G
 *   bridge — with `owner`, `collaborators`, cohort delivery metrics, per-branch
 *   rollups, `trend`, and cross-device `computeTargetIds` provenance populated,
 *   not just this machine's local components.
 * - **Local mode:** the local SQLite source (scope `"agent-components:local"`) —
 *   the same instance the outer stack already holds; this machine's components
 *   over IPC (it also exposes the local DB's `desktop:db:changed` push via
 *   `subscribe`, for the workspace's live-refresh path).
 *
 * Mirrors {@link DesktopSessionsViewSource}: only the provider *value* swaps, so
 * `children` (the mounted workspace) keep their position and local UI state
 * across a mode flip, and the `scope`-keyed cache plus the per-mode QueryClient
 * isolate the two inventories. `useApiClient()` is called unconditionally (Rules
 * of Hooks); the HTTP source is only constructed when the mode selects it.
 */
function DesktopAgentComponentsViewSource({
  mode,
  localSource,
  children,
}: Readonly<{
  mode: DesktopAppCoreMode;
  localSource: AgentComponentsDataSource;
  children: ReactNode;
}>) {
  const apiClient = useApiClient();
  const source = useMemo(
    () =>
      mode === DesktopAppCoreMode.Cloud
        ? createHttpAgentComponentsDataSource(apiClient)
        : localSource,
    [mode, apiClient, localSource]
  );
  return (
    <AgentComponentsDataSourceProvider dataSource={source}>
      {children}
    </AgentComponentsDataSourceProvider>
  );
}

/**
 * Selects the trace-comments source for the *views* (FEA-3460 / FEA-3522),
 * mirroring {@link DesktopSessionsViewSource} and
 * {@link DesktopAgentComponentsViewSource}.
 *
 * - **Cloud mode:** the shared HTTP source (scope `"http"`) so comments are read
 *   from AND written to the org cloud API over the D-G bridge — the same routes
 *   the web shell uses. FEA-3460 could only route reads over the bridge (it was
 *   GET-only, so a write over HTTP would be a silent status-0 network error);
 *   FEA-3522's authenticated write transport carries create / reply / update /
 *   delete through the bridge's trace-comment allowlist, so a comment authored on
 *   desktop in Cloud mode lands on the org.
 * - **Local mode / signed out / offline:** the desktop IPC source (scope
 *   `"desktop-local"`) — the same instance the outer stack already holds — for
 *   both reads and writes. Its SQLite store keeps its own cloud-sync push, so no
 *   local comment is lost.
 *
 * Always an inner `TraceCommentsDataSourceProvider` with only its *value*
 * swapped, so the mounted views keep their position and local UI state across a
 * mode flip. The `scope`-keyed comment query keys (see `traceCommentKeys`) plus
 * the per-mode QueryClient keep the two comment caches isolated.
 *
 * `useApiClient()` is called unconditionally (Rules of Hooks); the HTTP source
 * is only constructed when the mode actually selects it.
 */
function DesktopTraceCommentsViewSource({
  mode,
  localSource,
  children,
}: Readonly<{
  mode: DesktopAppCoreMode;
  localSource: TraceCommentsDataSource;
  children: ReactNode;
}>) {
  const apiClient = useApiClient();
  const source = useMemo(
    () =>
      mode === DesktopAppCoreMode.Cloud
        ? createHttpTraceCommentsDataSource(apiClient)
        : localSource,
    [mode, apiClient, localSource]
  );
  return (
    <TraceCommentsDataSourceProvider dataSource={source}>
      {children}
    </TraceCommentsDataSourceProvider>
  );
}

/**
 * Lazily builds the stack for `mode` and keeps it stable until the mode
 * changes. A ref rather than `useMemo` because these are live resources, not a
 * derived value: React may discard a `useMemo` cache at will, which here would
 * silently swap in a fresh QueryClient (dropping every cached query) and new
 * adapter identities mid-session. Same lazy-init idiom as the auth store in
 * `DesktopAuthProvider`.
 */
function useDesktopAppCoreStack(mode: DesktopAppCoreMode): DesktopAppCoreStack {
  const stackRef = useRef<{
    mode: DesktopAppCoreMode;
    stack: DesktopAppCoreStack;
  } | null>(null);
  if (stackRef.current?.mode !== mode) {
    stackRef.current = { mode, stack: createDesktopAppCoreStack(mode) };
  }
  return stackRef.current.stack;
}

function createDesktopAppCoreStack(
  mode: DesktopAppCoreMode
): DesktopAppCoreStack {
  return {
    mode,
    queryClient: createQueryClientForMode(mode),
    // Static (all flags off) only for the slice of the tree above `App`, which
    // mounts the real registry-backed `DesktopFeatureFlagProvider` for every
    // view. Kept so this provider is self-sufficient as a test/story wrapper.
    featureFlagAdapter: createStaticFeatureFlagAdapter(),
    apiAdapter: createDesktopCloudApiAdapter(window.desktopApi),
    localAgentComponentsDataSource: createLocalAgentComponentsDataSource(
      window.desktopApi
    ),
    localAgentSessionsDataSource: createLocalAgentSessionsDataSource(
      window.desktopApi
    ),
    localTraceCommentsDataSource: createDesktopTraceCommentsDataSource(
      window.desktopApi
    ),
  };
}

/**
 * Freshness model per mode (PLN-1138 D-E; opt-outs made explicit by ISS-5976).
 *
 * **Local** is a pure push model: `staleTime: Infinity` so the
 * `desktop:db:changed` bridges — not a timer — own freshness (FEA-1834), plus
 * the Sessions LIST background poll fallback (FEA-2187, see
 * {@link applyDesktopSessionsListPollDefaults}) for the visibility-gated bridge
 * on a hidden/offscreen renderer. Because it has that stream, local is the one
 * mode that opts OUT of the shared client's focus/reconnect refetch defaults,
 * and it now says so in its own `makeQueryClient` call rather than relying on
 * the factory defaulting them off for everybody — which is exactly how the web
 * shell ended up silently sharing a push-model policy it had no push stream for
 * (ISS-5976).
 *
 * **Cloud** has no push stream, so it takes a refetch model: refetch-on-focus
 * (one cheap freshness trigger) over the shared client's 1-minute `staleTime`.
 * The 2 s FEA-2187 poll is intentionally NOT applied — it heals a *local*-bridge
 * gap that doesn't exist on the cloud path, and a 2 s background poll against the
 * cloud API would be far too aggressive. Refetch-on-reconnect stays off: regaining
 * connectivity changes the mode, which rebuilds this client from empty and
 * refetches anyway. (SSE change-stream is the flagged v1 follow-up.)
 *
 * The still-local surfaces under the cloud client (insights, components) are
 * unaffected: insights set their own query-level `staleTime: Infinity` and ride
 * `InsightsLiveBridge`, so the cloud default never makes them stale.
 */
function createQueryClientForMode(mode: DesktopAppCoreMode): QueryClient {
  if (mode === DesktopAppCoreMode.Cloud) {
    return makeQueryClient({
      refetchOnWindowFocus: true,
      // ISS-5976: stated explicitly rather than inherited. The shared factory
      // now defaults reconnect ON, and cloud must NOT take that default:
      // regaining connectivity here changes the MODE, which rebuilds this
      // client from empty and refetches everything anyway, so a reconnect
      // refetch would be pure duplication. (SSE change-stream is the v1
      // follow-up that would replace the focus trigger too.)
      refetchOnReconnect: false,
    });
  }
  const client = makeQueryClient({
    staleTime: Number.POSITIVE_INFINITY,
    // ISS-5976: local is the ONE surface with a genuine push stream, so it is
    // the one place these opt-outs are earned rather than assumed. Verified,
    // not inherited from a comment: `desktop:db:changed` is emitted by the main
    // process and bridged into this client (FEA-1834), with the FEA-2187
    // visibility-gated Sessions-list poll below covering the hidden/offscreen
    // renderer the bridge cannot reach. Focus and reconnect would only add
    // redundant reads against a local SQLite store that already knows when it
    // changed.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  applyDesktopSessionsListPollDefaults(client);
  return client;
}
