/**
 * @file agent-dashboard-runtime-options.ts
 * @description The host-injected options contract for the Agent Dashboard
 * design-system runtime, plus the two aliases derived from it. Extracted out of
 * `agent-dashboard-design-system-runtime.ts` so
 * the runtime module and every sibling it now delegates to (db-host lifecycle,
 * IPC registration) share ONE definition of
 * this options object instead of re-declaring narrowed copies of it.
 */
import type { Harness } from "@repo/lib/harness/types";
import type { BrowserWindow, WebContents } from "electron";
import type { AgentMonitorRuntimeStatus } from "../../shared/agent-monitor-status.js";
import type { ReadSessionDeadLetterState } from "../agent-sync/agent-session-dead-letter-sync-state.js";
import type { SyncLaneBatchEmit } from "../agent-sync/sync-lane-cloud-health.js";
import type { CollectorEnabledState } from "../collectors/engine/collection-mode.js";
import type { DesktopAccountAdmission } from "../session/desktop-account-admission.js";
import type { SessionMeshHookSink } from "../session-mesh/session-mesh-hook-contract.js";
import type { GoldenModeConfig } from "../settings/golden-mode.js";
import type { DesktopImportHealthEventInput } from "../telemetry/app-otel-runtime-import-health.js";
import type { DesktopIpcPerfEventInput } from "../telemetry/app-otel-runtime-ipc.js";

export type AgentDashboardDesignSystemRuntimeOptions = {
  getWindow: () => BrowserWindow | null;
  /**
   * Session Mesh hook delivery after analysis consent. The listener owns parsing and
   * transport acknowledgement; the composed Mesh runtime owns canonical ID
   * resolution and cloud publication.
   */
  onSessionMeshHookEvent?: SessionMeshHookSink;
  /** Consent has released capture and the Mesh hook listener is bound. */
  onSessionMeshReady?: () => void;
  /**
   * True when an IPC event originates from this app's trusted renderer. Wired
   * from `DesktopWindow.isTrustedSender` so every `desktop:db:*` handler gates
   * on sender trust the same way the gateway-dispatch and renderer-otel handler
   * families do — defense-in-depth against a compromised renderer.
   */
  isTrustedSender: (sender: WebContents) => boolean;
  whenInitialDashboardDataServed?: () => Promise<void>;
  whenInitialBackgroundWorkAllowed?: () => Promise<void>;
  waitForRendererBackgroundSlot?: () => Promise<void>;
  /**
   * ISS-4711: `true` when a renderer IPC read landed within the recent quiet
   * window (i.e. the UI is actively being served). The DATA_REVISION rebuild
   * consults this per session write to keep its full cooperative pause ONLY
   * while the renderer is active, and to drop to a flat-floor-free fast path
   * when the renderer is idle — turning a multi-hour serial rebuild into
   * minutes without janking the UI. Backed by the max of the last trusted DB
   * IPC read (stamped via `onRendererDbRead` below) and the last user-input
   * event, so a hands-off-keyboard auto-refreshing list still counts as active.
   */
  hasRecentRendererRead?: () => boolean;
  /**
   * ISS-4711: fired after every trusted DB IPC read is served by `withDb`, so
   * the host can stamp a "renderer just read" timestamp that keeps
   * `hasRecentRendererRead` honest for polling/auto-refresh reads that fire no
   * user-input event. Trust is already enforced by `withDb`'s `isTrustedSender`
   * gate before this runs.
   */
  onRendererDbRead?: () => void;
  onFirstDbIpcServed?: () => void;
  onInitialCollectorImportComplete?: () => void;
  /**
   * ISS-4428: fired once the startup catalog seed has been applied, i.e. the
   * local `pack_catalog` is populated. This is the true "runtime ready to
   * install" signal for the required-plugin installer: on a fresh database the
   * runtime object exists (and serves renderer IPC) well before the deferred
   * startup maintenance seeds `pack_catalog`, so an installer retry fired on the
   * bare runtime-object-ready point would hit an unseeded catalog, resolve every
   * `installPack` to `ENOTFOUND` (reported `failed`), and never reconcile again
   * when the seed lands. Firing the installer retry from here instead closes
   * that fresh-DB ordering gap. Idempotent: the seed runs on every boot (upsert),
   * so an already-seeded install still gets the retry.
   */
  onCatalogSeeded?: () => void;
  /** Stored `sk_live_*` desktop API key, consumed by org-directory warming. */
  getApiKey?: () => string | null;
  /** FEA-3425: first-party Desktop session token. */
  getAccessToken?: () => Promise<string | null>;
  getApiOrigin?: () => string;
  getComputeTargetId?: () => string | null;
  /**
   * FEA-3659: IDENTITY-SCOPED compute target — the id the session sync lane
   * writes under, or null when none is attributable to the account signed in
   * now. Distinct from `getComputeTargetId`, which deliberately falls back to
   * the last-known (possibly stale) `lastComputeTargetId` so offline
   * component reads can still resolve cloud artifacts. The
   * data-revision sync-outbox enqueue must NOT use that stale fallback:
   * enqueuing under a stale source key strands rows under the wrong key across
   * an account switch. Mirrors the sync service's own `getSyncComputeTargetId`
   * so the enqueue and the read side agree on the source key.
   *
   * ISS-8691: that target may be RETAINED from the last hello while the socket
   * reconnects, so this is no longer null merely because we are offline. The
   * account-switch guarantee is unchanged — the retained id is bound to its
   * owner and re-checked on every read, so it resolves null the moment a
   * different account is signed in.
   */
  getSyncComputeTargetId?: () => string | null;
  /**
   * ISS-11427: whether the session lane holds a session as a dead letter or
   * has abandoned it. Optional so fakes and older wiring report neither.
   */
  readSessionDeadLetterState?: ReadSessionDeadLetterState;
  /**
   * ISS-4546: inject the ids the data-revision
   * rebuild just enqueued into the durable sync outbox into the sync service's
   * LIVE `backfillQueue`, so they reach the cloud THIS session instead of waiting
   * for the next restart's `loadPendingOutboxIds` re-hydration. Wired to the
   * `AgentSessionSyncService.injectBackfillIds`, which is dedup-safe and
   * hydration-first (it no-ops until the current identity is hydrated, leaving the
   * ids for the pending hydration's own re-enqueue).
   *
   * `capturedSourceKey` is the identity CAPTURED at enqueue time (PR #4098 review,
   * whitlockk). The sync service refuses the inject unless it still matches the
   * live+hydrated identity, so ids enqueued under target A can never enter target
   * B's live lane if the compute target flipped while the outbox/marker writes were
   * awaited. Omitted contexts (tests without a sync service) simply skip the
   * same-session latency optimization — the durable outbox remains the backstop, so
   * nothing is stranded.
   */
  injectSyncBackfillIds?: (
    ids: readonly string[],
    capturedSourceKey: string | null
  ) => void;
  getUserIdentity?: () => {
    userId: string | null;
    organizationId: string | null;
  } | null;
  /**
   * ISS-6243: subscribe to TRANSITIONS of the identity `getUserIdentity` reads —
   * a background `/me` landing after a cold start, a key rotation on an org
   * switch, a key removal on sign-out. Returns the unsubscribe.
   *
   * The db host serves `getUserIdentity` synchronously from a cache that only
   * main can fill, and the Init snapshot is `null` by construction on a cold
   * start (the resolver warms `/me` in the background and returns null meanwhile).
   * Without this subscription the child holds that null for its entire lifetime
   * and every session writer stamps a null owner. Omit ⇒ the pre-ISS-6243
   * behavior: the Init snapshot is never refreshed.
   */
  subscribeUserIdentityChanged?: (listener: () => void) => () => void;
  getAccountAdmission?: () => DesktopAccountAdmission | null;
  /**
   * ISS-10533 (marisolashgrove review): is the desktop GENUINELY signed out, as
   * opposed to merely identity-less right now?
   *
   * `DesktopSessionManager.getIdentity()` is null whenever `this.session` is,
   * which covers several distinct states — `Loading` (before `restore()`, which
   * awaits a network refresh), `SignedOut`, and `RefreshFailed` after the
   * background `clearSession(DesktopAuthStatus.RefreshFailed)`. Only the middle
   * one means "nobody was signed in".
   */
  isDesktopSessionSignedOut?: () => boolean;
  /**
   * FEA-3741 (slice 1): reads the per-tool collector enable toggles
   * (`collectClaudeEnabled` / `collectCursorEnabled` / `collectCopilotEnabled`,
   * SettingsStore, default ON). Resolved fresh at each collector (re)start so a
   * toggle flip (which restarts collectors) takes effect. A harness whose entry
   * is `false` is routed to `"disabled"` mode AND skipped entirely by the
   * manager (no watcher, no tool-home walk). Omit → every harness enabled.
   */
  getCollectorEnabledState?: () => CollectorEnabledState;
  /**
   * ISS-7352: whether the OTLP receiver's decoded Claude Code signals are
   * persisted (`claudeCodeOtelCapture`, SettingsStore, default OFF). Read fresh
   * on every export so a toggle flip takes effect without a restart. Omit →
   * capture stays off, which is the shipped default.
   */
  isClaudeCodeOtelCaptureEnabled?: () => boolean;
  onTerminalFailure: (reason: string) => void;
  /**
   * Publish the first-class Agent Monitor runtime status the renderer reads over
   * `desktop:get-runtime-status` (davetho, #6432).
   *
   * Distinct from {@link onTerminalFailure}, which owns the notification and the
   * tray only. Boot-time failures already publish through
   * `agent-dashboard-runtime-bootstrap.ts`; this is the seam that lets a runtime
   * that failed AFTER boot — the ISS-8776 restart-ladder exhaustion — say so
   * too, instead of leaving the status latched at `ready`.
   *
   * Required, not optional: a missing wire is exactly the silent-healthy defect
   * this exists to close, so it must fail typecheck rather than degrade.
   */
  setAgentMonitorRuntimeStatus: (status: AgentMonitorRuntimeStatus) => void;
  /**
   * A live agent session reached a terminal status (completed/error). Wired by
   * the app to fire a desktop completion Notification with a click-through to
   * the session detail, gated on the session-completion-notifications flag.
   */
  onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
  /**
   * FEA-2715: a Claude hook event arrived (the transcript archive lane uses it
   * to enqueue the session's transcript — terminal events flush immediately,
   * activity events debounce). Fire-and-forget; wired only when the transcript
   * feature flag is on.
   */
  onTranscriptHookEvent?: (
    hookType: string,
    data: Record<string, unknown>
  ) => void;
  /**
   * FEA-3640: a live-watcher import produced a session (any harness), carrying
   * the transcript source that changed. The transcript archive lane arms its
   * shared ~5 min activity flush from this, so watcher-mode harnesses get the
   * same cadence the Claude hook channel already had instead of waiting for the
   * 30-min discovery sweep. Fire-and-forget; wired only when the transcript
   * feature flag is on.
   *
   * ISS-4390: `changedPaths` carries the ORIGINAL changed path(s) behind
   * `sourcePath` (which, for a child rollout or subagent sidecar, is the folded
   * root). Optional and additive.
   */
  onLiveTranscriptActivity?: (
    harness: Harness,
    externalSessionId: string,
    sourcePath: string,
    changedPaths?: readonly string[]
  ) => void;
  /**
   * Goal stage 3 (event-driven sync pump): a collector import just WROTE
   * new/changed session data locally (the same post-write moment the renderer's
   * `desktop:db:changed` emit fires on). Wired to
   * `AgentSessionSyncService.notifyLocalSessionActivity` so the sync lane runs
   * a pass within ~one tick of arrival instead of waiting for the 5s fallback
   * sweep. Fire-and-forget and main-process-originated — never gated on
   * renderer state (`main/sync/AGENTS.md` invariant 9).
   */
  onLocalSessionDataChanged?: () => void;
  /** Wake sync lanes once the initial session projection may be uploaded. */
  onInitialSessionProjectionReady?: () => void;
  userDataPath?: string;
  /**
   * FEA-2648 golden mode: ingest ONLY the staged golden corpus. When set, the
   * OTLP receiver, hook listener, watchers, and the utility-process historical
   * parser stay off; the one-shot boot import parses in-process through
   * corpus-rooted collectors. userData was already redirected to the throwaway
   * golden profile at startup.
   */
  golden?: GoldenModeConfig | null;
  log?: (scope: string, message: string) => void;
  /**
   * Emit an IPC perf wide event (FEA-1997). Wired to the desktop OTel runtime's
   * `emitIpcPerfEvent`; omitted in contexts without a telemetry runtime, in
   * which case the `list`/`detail`/`usage` handlers run uninstrumented.
   */
  emitIpcPerf?: (input: DesktopIpcPerfEventInput) => void;
  /**
   * ISS-5103: emit a desktop import-health record. Wired to the desktop OTel
   * runtime's `emitImportHealthEvent`; omitted in contexts without a telemetry
   * runtime, in which case import-health tracking is not installed at all (no
   * tally, no sentinel count queries).
   */
  emitImportHealth?: (input: DesktopImportHealthEventInput) => void;
  /** ISS-6338: emit a sync lane's per-batch cloud health. */
  emitSyncBatch?: SyncLaneBatchEmit;
};

export type AgentDashboardLog = NonNullable<
  AgentDashboardDesignSystemRuntimeOptions["log"]
>;

/**
 * FEA-2038: forwards a `store:`-prefixed op (a store fn that takes a callback and
 * must run wholly in the DB host) to the child over IPC. `args` must be
 * structured-clone-safe — never a function.
 */
export type InvokeStoreOp = (
  name: string,
  args?: unknown[]
) => Promise<unknown>;
