import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { createHttpAgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AgentComponentsLiveBridge } from "@repo/app/agents/data-source/agent-components-live-bridge";
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
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { SettingsHostAdapterProvider } from "@repo/app/shared/settings-host/provider";
import { createHttpTraceCommentsDataSource } from "@repo/app/shared/trace-comments/trace-comments-data-source";
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
import { useSyncConsentRecord } from "../components/onboarding/use-sync-consent-record";
import {
  createDesktopRoutingAdapter,
  ensureDesktopRoutingSelection,
} from "../engineer/desktop-routing-adapter";
import { DesktopFeatureFlagProvider } from "../feature-flags/desktop-feature-flag-provider";
import { DesktopRealtimeProvider } from "../realtime/desktop-realtime-provider";
import { useRendererExceptionReporter } from "../renderer-exception-reporter";
import { createDesktopSettingsHostAdapter } from "../settings-host/desktop-settings-host-adapter";
import { DesktopBranchesConsumptionProvider } from "../shared-branches/desktop-branches-consumption";
import { useAppCoreQueryIdentity } from "./app-core-query-identity";
import { createDesktopCloudApiAdapter } from "./cloud-api-adapter";
import { CloudSessionsSyncBridge } from "./cloud-sessions-sync-bridge";
import { createDesktopCloudPrimaryAgentSessionsDataSource } from "./desktop-agent-sessions-data-source";
import {
  DesktopAppCoreMode,
  DesktopAppCoreModeContext,
  DesktopLocalReadReason,
  resolveDesktopAppCoreMode,
  resolveDesktopLocalReadReason,
} from "./desktop-app-core-mode";
import { DesktopAuthProvider, useDesktopAuth } from "./desktop-auth-provider";
import { DesktopParsingBugFlagProvider } from "./desktop-parsing-bug-flag-provider";
import { DesktopTranscriptTransportProvider } from "./desktop-transcript-transport";
import { InsightsLiveBridge } from "./insights-live-bridge";
import { createLocalAgentComponentsDataSource } from "./local-agent-components-data-source";
import { createLocalAgentSessionsDataSource } from "./local-agent-sessions-data-source";
import { applyDesktopSessionsListPollDefaults } from "./sessions-list-poll-defaults";
import { useOnlineStatus } from "./use-online-status";

/**
 * Why a surface outside a mounted provider is local: nobody is signed in.
 * Matches {@link DesktopAppCoreModeContext}'s `Local` default so a view rendered
 * in a test/story wrapper sees one consistent story.
 */
const DesktopLocalReadReasonContext = createContext<
  DesktopLocalReadReason | undefined
>(DesktopLocalReadReason.SignedOut);

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
 * WHY the active read source is local — signed out, offline, or sync off — or
 * `undefined` when the reader is on the cloud.
 *
 * Surfaces that already tell the user which source they are reading (the
 * read-source badge) consume this to say why, rather than a parallel indicator
 * growing beside them. Derived beside the mode from the same input, so the badge
 * and the source can never describe different situations.
 */
export function useDesktopLocalReadReason():
  | DesktopLocalReadReason
  | undefined {
  return useContext(DesktopLocalReadReasonContext);
}

/**
 * Desktop app-core provider stack for shared `@repo/app` telemetry views.
 *
 * `DesktopAuthProvider` (FEA-2219) sits at the root — above the rest of the
 * stack — because the live auth state it mirrors from the main-process session
 * manager is (with connectivity and sync consent) what *selects* the stack
 * (PLN-1138 D-E). See `resolveDesktopAppCoreMode`: a renderer runs the cloud
 * stack once it is authenticated, online, AND permitted to sync; every other
 * state runs local. {@link DesktopAppCoreModeStack} rebuilds the stack as one
 * unit per mode, so the app never observes a half-configured stack and login /
 * logout / connectivity flip it at runtime with no reload.
 *
 * `ApiAdapterProvider` carries the cloud transport (PLN-1138 D-G Option B):
 * `createDesktopCloudApiAdapter` marshals cloud REST requests over IPC to the
 * main process, which resolves the API origin and attaches the first-party
 * session token (signed-out requests short-circuit to 401 in main). The
 * credential never enters renderer JS — the auth port surfaces only a sentinel.
 *
 * **Sessions source selection (Phase 2, this file's job):** the Sessions views
 * use a Desktop cloud-primary adapter when authenticated + online + permitted
 * to sync. It reads the org cloud API first and can retain honest local or
 * last-good evidence after that read fails. Other modes keep the local SQLite
 * source (scope `"local"`, over IPC). The `scope`-keyed React Query keys plus
 * the per-mode QueryClient keep the sets isolated. See
 * {@link DesktopSessionsViewSource}.
 *
 * **Agent-components source selection (FEA-3459):** like Sessions, the
 * agent-components workspace reads the org cloud API (the shared HTTP source,
 * scope `"agent-components:http"`) when authenticated + online + permitted to
 * sync, and the local SQLite source (scope `"agent-components:local"`)
 * otherwise — so Cloud mode shows the org-wide deduped inventory with
 * owner/collaborators/cohort metrics/branches/multi-device provenance
 * populated, not just this machine's local components. See
 * {@link DesktopAgentComponentsViewSource}.
 *
 * **Comments read and write the cloud API in every mode (PLN-2162 M5.2):**
 * desktop keeps no comment data locally (Kerensa, 2026-10-05), so the trace-comment
 * views always use the shared HTTP source over the D-G bridge. Signed out or
 * offline, that read fails and the views show their existing failed-load
 * state. See {@link DesktopTraceCommentsSource}.
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
  // This is the single app-core mount: each effect run registers
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
      <DesktopFeatureFlagProvider>
        <DesktopTranscriptTransportProvider>
          <DesktopAppCoreModeStack>{children}</DesktopAppCoreModeStack>
        </DesktopTranscriptTransportProvider>
      </DesktopFeatureFlagProvider>
    </DesktopAuthProvider>
  );
}

/** Every port the app-core stack injects, built as one unit per mode. */
type DesktopAppCoreStack = {
  mode: DesktopAppCoreMode;
  queryClient: QueryClient;
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
  // Still read HERE, and no longer read by the mode below: the Settings adapter
  // needs `refresh` so a saved sync level is re-read. What left is the read
  // SOURCE's dependency on it — consent governs what LEAVES this Mac, and the
  // reader's workspace is theirs to read either way (operator ruling,
  // 2026-09-25). The egress gate reads the record in main, not here; see
  // `resolveDesktopAppCoreMode`.
  //
  // Only `refresh` is wanted, and it is stable; the record subscription this
  // call also opens is INCIDENTAL, and a re-render of this component on a
  // consent change is harmless because the mode below does not read the record.
  const consent = useSyncConsentRecord(state.userId);
  const modeInput = useMemo(
    () => ({
      isOnline,
      status: state.status,
    }),
    [isOnline, state.status]
  );
  const mode = resolveDesktopAppCoreMode(modeInput);
  const localReadReason = resolveDesktopLocalReadReason(modeInput);
  const stack = useDesktopAppCoreStack(mode);
  useAppCoreQueryIdentity(
    stack.queryClient,
    state.userId,
    state.organizationId
  );
  const settingsHostAdapter = useMemo(
    () =>
      createDesktopSettingsHostAdapter(
        window.desktopApi,
        state.organizationId,
        consent.refresh
      ),
    [consent.refresh, state.organizationId]
  );

  return (
    <DesktopLocalReadReasonContext.Provider value={localReadReason}>
      <DesktopAppCoreModeContext.Provider value={mode}>
        {/* ISS-5714 / ISS-6972: Branches reads the SAME mode Sessions does
            rather than re-deriving one from auth state. This component never
            remounts, so the Branch QueryClient still survives every mode
            transition. */}
        <DesktopBranchesConsumptionProvider
          readsCloud={mode === DesktopAppCoreMode.Cloud}
        >
          {/*
            KEYED BY THE CLIENT'S OWN MODE, and the key is load-bearing
            (ISS-11249). `useDesktopAppCoreStack` builds a NEW `QueryClient`
            whenever the mode changes, and React Query binds an observer to the
            client it saw on its FIRST render and never rebinds it when the
            context value changes. Without a key the subtree keeps every
            observer it already had, so after a mode flip those queries read a
            cache nothing writes to any more: an imperative
            `setQueryData`/`getQueryData` (which resolve the CURRENT client)
            lands in the new cache while the mounted reader still renders the
            discarded one's value, forever and silently.

            That is what kept the resumed sync step off screen — the card's
            transition wrote the advanced run, the server accepted it, and the
            modal's own snapshot query was bound to the pre-flip client and
            never saw it.

            Remounting is the honest accompaniment to swapping the client: a new
            client has an empty cache, so every read below refetches on a mode
            flip either way.
          */}
          <QueryClientProvider client={stack.queryClient} key={stack.mode}>
            <ApiAdapterProvider adapter={stack.apiAdapter}>
              <DesktopRealtimeProvider
                enabled={stack.mode === DesktopAppCoreMode.Cloud}
              >
                {/* ISS-8379: the Settings host port. Mounted above both the
                    legacy and the v2 Settings trees so either can consume the
                    same adapter during rollout; it renders nothing and reads no
                    experience flag. */}
                <SettingsHostAdapterProvider adapter={settingsHostAdapter}>
                  <DesktopAgentComponentsViewSource
                    localSource={stack.localAgentComponentsDataSource}
                    mode={stack.mode}
                  >
                    {/* ISS-6882: the Agents workspace's only invalidation channel.
                      The local QueryClient below runs staleTime: Infinity with
                      focus/reconnect refetches off, so without this bridge an
                      import/install/uninstall/rescan left the component list,
                      summary, facets, and detail stale until a renderer restart.
                      Mounted unconditionally rather than gated on mode: the view
                      source above already swaps to the HTTP source in cloud mode,
                      and that source exposes no `subscribe`, so the bridge is an
                      inert no-op there. */}
                    <AgentComponentsLiveBridge />
                    <DesktopTraceCommentsSource>
                      <AgentSessionsDataSourceProvider
                        dataSource={stack.localAgentSessionsDataSource}
                      >
                        {/* Insights stay local in both modes (Phase 3 migrates them);
                    the outer local source above feeds their push stream. */}
                        <InsightsLiveBridge />
                        {/* The Sessions views' refresh channel for this mode, one
                    slot either way so the source layer below keeps a stable
                    position across mode swaps. Local: the local DB's push
                    stream. Cloud: the views read HTTP (local DB changes are
                    irrelevant to them and the push bridge is inert), so the
                    trigger is this machine's own upsync lane — the rows it is
                    landing in the cloud are exactly what the list is missing. */}
                        {stack.mode === DesktopAppCoreMode.Local ? (
                          <AgentSessionsLiveBridge />
                        ) : (
                          <CloudSessionsSyncBridge />
                        )}
                        <DesktopSessionsViewSource
                          localSource={stack.localAgentSessionsDataSource}
                          mode={stack.mode}
                          organizationId={state.organizationId}
                          userId={state.userId}
                        >
                          <DesktopParsingBugFlagProvider>
                            {children}
                          </DesktopParsingBugFlagProvider>
                        </DesktopSessionsViewSource>
                      </AgentSessionsDataSourceProvider>
                    </DesktopTraceCommentsSource>
                  </DesktopAgentComponentsViewSource>
                </SettingsHostAdapterProvider>
              </DesktopRealtimeProvider>
            </ApiAdapterProvider>
          </QueryClientProvider>
        </DesktopBranchesConsumptionProvider>
      </DesktopAppCoreModeContext.Provider>
    </DesktopLocalReadReasonContext.Provider>
  );
}

/**
 * Selects the Sessions read source for the *views* (PLN-1138 D-E / Phase 2).
 *
 * - **Cloud mode, rollout off:** the original HTTP source is returned intact.
 * - **Cloud mode, rollout on:** the Desktop cloud-primary source reads HTTP
 *   first, then local or last-good evidence on failure.
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
  organizationId,
  userId,
  children,
}: Readonly<{
  mode: DesktopAppCoreMode;
  localSource: AgentSessionsDataSource;
  organizationId: string | null;
  userId: string | null;
  children: ReactNode;
}>) {
  const apiClient = useApiClient();
  const reportException = useRendererExceptionReporter();
  const gridviewAdoptionEnabled = useFeatureFlagEnabledOptional(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  const source = useMemo(() => {
    if (mode !== DesktopAppCoreMode.Cloud) {
      return localSource;
    }
    const cloudSource = createHttpAgentSessionsDataSource(apiClient);
    if (!gridviewAdoptionEnabled) {
      return cloudSource;
    }
    return createDesktopCloudPrimaryAgentSessionsDataSource({
      cloudSource,
      identity: { organizationId, userId },
      localSource,
      reportCloudReadFailure: reportException,
    });
  }, [
    mode,
    apiClient,
    localSource,
    organizationId,
    reportException,
    gridviewAdoptionEnabled,
    userId,
  ]);
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
 *
 * ISS-6888: this provides the local source with its `honorsDateWindow: true`
 * declaration INTACT. The capability's rollout gate remains in
 * `DesktopAgentsDateWindowGate`; this provider does not decide it.
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

function DesktopTraceCommentsSource({
  children,
}: Readonly<{ children: ReactNode }>) {
  const apiClient = useApiClient();
  const source = useMemo(
    () => createHttpTraceCommentsDataSource(apiClient),
    [apiClient]
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
    apiAdapter: createDesktopCloudApiAdapter(window.desktopApi),
    localAgentComponentsDataSource: createLocalAgentComponentsDataSource(
      window.desktopApi
    ),
    localAgentSessionsDataSource: createLocalAgentSessionsDataSource(
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
    // Every local read AND WRITE on this client is SQLite over IPC, which needs
    // no network, and going offline is the state that SENDS a surface here —
    // since sync consent stopped gating reads it is the ONLY state that sends a
    // SIGNED-IN reader here, so anything paused on connectivity is paused for
    // every local reader that still exists. React Query's stock
    // `networkMode: "online"` pauses a first fetch on an empty cache while the
    // machine is offline, so without this a cold offline start leaves Sessions,
    // components and insights on a skeleton that never resolves — and it pauses
    // MUTATIONS the same way, which is worse than a skeleton: a control renders,
    // takes the click, and silently does nothing until the machine is back
    // online.
    //
    // Accepted cost: the cloud-only HTTP queries that also ride this client
    // while signed out or offline (comments, GitHub integration status, admin
    // pack views, the audit view's projects and org users) fail fast with a
    // transport error instead of pausing, and no longer auto-resume on
    // reconnect. An honest error beats an indefinite skeleton; for comments it
    // is the failed-load state PLN-2162 decision 11 calls for.
    networkMode: "always",
  });
  applyDesktopSessionsListPollDefaults(client);
  return client;
}
