/**
 * @file agent-dashboard-runtime-options.ts
 * @description The host-injected options contract for the Agent Dashboard
 * design-system runtime, plus the two aliases derived from it. Extracted out of
 * the shrink-only grandfathered `agent-dashboard-design-system-runtime.ts` so
 * the runtime module and every sibling it now delegates to (db-host lifecycle,
 * IPC registration, the trace-comment cloud sync lane) share ONE definition of
 * this options object instead of re-declaring narrowed copies of it.
 */
import type { Harness } from "@repo/lib/harness/types";
import type { BrowserWindow, WebContents } from "electron";
import type {
  ScheduledReviewRequest,
  ScheduledReviewResult,
} from "../../shared/scheduled-review-contract.js";
import type { DesktopCloudSessionIdentity } from "../cloud/desktop-cloud-github-hydration.js";
import type { CollectorEnabledState } from "../collectors/engine/collection-mode.js";
import type { GoldenModeConfig } from "../settings/golden-mode.js";
import type { DesktopIpcPerfEventInput } from "../telemetry/app-otel-runtime.js";
import type { DesktopImportHealthEventInput } from "../telemetry/app-otel-runtime-import-health.js";

export type AgentDashboardDesignSystemRuntimeOptions = {
  getWindow: () => BrowserWindow | null;
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
  /**
   * Stored `sk_live_*` desktop API key. Still consumed by org-directory
   * warming; branch cloud hydration uses it only as the legacy FALLBACK
   * credential (session-first since PLN-1535 M3); the cloud trace-comment
   * lanes no longer use it at all (session-only since PLN-1437 Phase 4a).
   */
  getApiKey?: () => string | null;
  /**
   * FEA-3425: first-party Desktop session token — the credential for the cloud
   * trace-comment lanes.
   */
  getAccessToken?: () => Promise<string | null>;
  /**
   * FEA-3425: synchronous "is a first-party session live" probe so the
   * (synchronous) cloud-auth availability gate can count session auth without
   * awaiting a token read.
   */
  hasDesktopSessionAuth?: () => boolean;
  getApiOrigin?: () => string;
  getProfileId?: () => string | null;
  getComputeTargetId?: () => string | null;
  /**
   * FEA-3659: ONLINE-AWARE compute target — the id of the currently-connected
   * cloud compute target, or null when offline/unauthenticated. Distinct from
   * `getComputeTargetId`, which deliberately falls back to the last-known
   * (possibly stale) `lastComputeTargetId` so offline trace-comment / component
   * reads can still resolve cloud artifacts. The data-revision sync-outbox
   * enqueue must NOT use that stale fallback: enqueuing under a stale source key
   * strands rows under the wrong key across an account switch. Mirrors the sync
   * service's own `getSyncComputeTargetId` (null-when-offline) so both the
   * enqueue and the read side agree on the source key when online.
   */
  getSyncComputeTargetId?: () => string | null;
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
   * wongk). The sync service refuses the inject unless it still matches the
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
  /**
   * PR #3994 review P0: the signed-in Desktop session's account identity
   * (`DesktopSessionManager.getIdentity()`), non-null whenever a session
   * (stored or live, incl. during boot restore) exists. Branch cloud
   * hydration's session lane gates on it AND scopes every cached/persisted
   * overlay to `session:<orgId>:<userId>` — without it, session-auth accounts
   * on one machine would share a cache identity and could read each other's
   * private PR overlays. Distinct from `getUserIdentity`, which resolves the
   * API-KEY account via `/me` and is null for session-only installs.
   */
  getSessionIdentity?: () => DesktopCloudSessionIdentity | null;
  /**
   * Invalidate the cached session token on an HTTP 401
   * (`DesktopSessionManager.invalidateAccessToken()`), matching the other
   * session-backed HTTP lanes.
   */
  invalidateAccessToken?: () => void;
  /**
   * FEA-4169: live "may session data egress at all?" gate, ANDing the
   * server-owned ORG POLICY over per-device sync consent (the same predicate the
   * bulk sync/transcript lanes read via `isSessionMetadataSyncTierAllowed`). The
   * trace-comment recovery path (`syncCloudSessionForTraceComments`) posts the
   * local parent SESSION artifact directly to `/desktop/agent-sessions/sync` when
   * a comment hits a missing-session response, bypassing those lane gates; wiring
   * this in makes that path honor an explicit policy-off just like the lanes do,
   * so it never sends the parent session for a policy-disabled org. Read live so a
   * policy flip is picked up on the next recovery attempt. Omit ⇒ allowed (the
   * pre-FEA-4169 behavior), so an unwired/older host never newly suppresses sync.
   */
  isSessionSyncAllowed?: () => boolean;
  /**
   * ISS-4578 (P1 #10): live "did the server advertise
   * `agentSessionSyncActivityChunking`?" probe. The trace-comment recovery path
   * (`syncCloudSessionForTraceComments`) prepares the parent-session payload
   * directly, so it needs the SAME negotiated capability the bulk sync lane
   * reads to paginate an oversized activity tiling across chunks. Omit ⇒ false
   * (skew-safe: the tiling stays in the base and an oversized one dead-letters
   * for a larger-payload retry, never a silent truncation).
   */
  isSyncActivityChunkingSupported?: () => boolean;
  /**
   * FEA-3741 (slice 1): reads the per-tool collector enable toggles
   * (`collectClaudeEnabled` / `collectCursorEnabled` / `collectCopilotEnabled`,
   * SettingsStore, default ON). Resolved fresh at each collector (re)start so a
   * toggle flip (which restarts collectors) takes effect. A harness whose entry
   * is `false` is routed to `"disabled"` mode AND skipped entirely by the
   * manager (no watcher, no tool-home walk). Omit → every harness enabled.
   */
  getCollectorEnabledState?: () => CollectorEnabledState;
  onTerminalFailure: (reason: string) => void;
  /**
   * A live agent session reached a terminal status (completed/error). Wired by
   * the app to fire a desktop completion Notification with a click-through to
   * the session detail, gated on the session-completion-notifications flag.
   */
  onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
  /**
   * FEA-4143: run a scheduled review that the db-host daemon proxied to main.
   * Wired by the app to the shared `runScheduledReviewThroughAuditService`
   * composition over the SAME `AuditService` the on-demand Audit view uses, so
   * the scheduled and on-demand paths cannot diverge (workspace safety +
   * credential boundary + parity). Omitted ⇒ a fired review task records a skip.
   */
  onRunScheduledReview?: (
    request: ScheduledReviewRequest
  ) => Promise<ScheduledReviewResult>;
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
