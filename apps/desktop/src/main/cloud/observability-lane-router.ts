/**
 * @file observability-lane-router.ts
 * @description FEA-3425 (PLN-1437 Phase 3): the write-lane routing for the two
 * best-effort observability lanes — product analytics (`desktop.analytics`) and
 * diagnostics telemetry (`desktop.telemetry`). Owns the two authenticated HTTP
 * twins and the bounded shutdown drain, kept off the application god-object so
 * the next observability lane lands here, not in `app.ts`.
 *
 * HTTP-only since PLN-1437 Phase 4a: the legacy relay-socket fallback was
 * retired once session coverage cleared the D7 no-strand gate. An event is sent
 * over the HTTP twin when a first-party session is live and the socket-derived
 * compute-target identity is known. ISS-12420 buffers authenticated onboarding
 * events during readiness gaps; other events remain a best-effort DROP (matching
 * the retired socket lane's silent drop on disconnect). The HTTP twins own the
 * per-outcome durability policy; this router only gates the send and orders the
 * shutdown drain.
 *
 * ISS-10503 (PRD-736 D5): analytics ONLY (never telemetry) has a second, PRE-AUTH
 * path. An event emitted while no first-party session is signed in is sent
 * unauthenticated under a client-supplied distinct id — the live onboarding
 * attempt's `flow_id`, or the install's node_uuid once the account step is
 * skipped / for a single-player install's non-flow events — instead of being
 * dropped. A signed-out MULTIPLAYER install's non-flow events still drop, and an
 * AUTHENTICATED install never falls back to an anonymous person. Onboarding
 * events wait in the bounded readiness queue when its target is unresolved.
 * The first authenticated sends after account establishment carry the attempt id as the
 * alias trigger until an ack attests the merge (`aliased: true`).
 *
 * ISS-8687: ONE family is exempt from the socket-derived half of that gate.
 * `desktop_connection_lost` / `desktop_connection_degraded` fire exactly when
 * the socket is down, so the gate made the two events describing a lost
 * connection permanently undeliverable — neither has ever reached PostHog from
 * any client. They resolve their target from the RETAINED identity instead
 * ({@link ObservabilityLaneRouterOptions.getRetainedComputeTargetId}); which
 * events qualify, and why that list is an exhaustive table rather than a set of
 * two, is `offline-deliverable-analytics-events.ts`. Everything else — every
 * other analytics event, and the whole telemetry twin — keeps the strict-online
 * gate. Onboarding alone may wait for that gate rather than drop immediately.
 */
import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import {
  FirstOrgUserValue,
  isUuidV4,
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { DesktopAuthStatus } from "../../shared/contracts.js";
import type { DesktopSignInAnalytics } from "../session/desktop-sign-in-analytics.js";
import { setTelemetryDeliverable } from "../telemetry/telemetry-delivery-readiness.js";
import type { SessionFetchOptions } from "../util/api-response-utils.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import type { DesktopAuthFailureEventInput } from "./auth-failure-telemetry.js";
import {
  createDesktopAnalyticsHttpLane,
  type DesktopAnalyticsLaneEvent,
} from "./desktop-analytics-http-lane.js";
import { registerDesktopSignInAnalytics } from "./desktop-sign-in-analytics-client.js";
import {
  createDesktopTelemetryHttpClient,
  type DesktopTelemetryLaneEvent,
} from "./desktop-telemetry-http-client.js";
import { isOfflineDeliverableAnalyticsEvent } from "./offline-deliverable-analytics-events.js";
import {
  createOnboardingAnalyticsQueue,
  isQueuedOnboardingEvent,
} from "./onboarding-analytics-queue.js";

export type ObservabilityLaneRouterOptions = SessionFetchOptions & {
  getIdentity: () => SignedInUserIdentity | null;
  getAppVersion: () => string;
  /**
   * Resolves the Code plugin version for the `x-desktop-plugin-version` header
   * on every HTTP write, kept in parity with the socket path's hello-derived
   * value. NOT the Electron app version.
   */
  getPluginVersion: () => string;
  /**
   * Invoked on HTTP 401 so the owner drops its cached access token and the next
   * send presents a fresh credential. Shared by both HTTP twins.
   */
  onUnauthorized: () => void;
  /**
   * ISS-6334: report the 401 onto the UNAUTHENTICATED relay pipe before the
   * token is invalidated. Both HTTP twins funnel their 401 through
   * `onUnauthorized`, so wrapping it here covers the whole lane rather than one
   * twin — and it is the only way a rejected token is visible at all, since the
   * twins otherwise swallow a 401 into a best-effort DROP.
   */
  reportAuthFailure?: (input: DesktopAuthFailureEventInput) => void;
  /**
   * Live HTTP-transport readiness — the same predicate Lane 1 uses
   * (`isHttpAgentSessionSyncReady`), passed in so the observability lanes stay
   * on the single readiness rule rather than duplicating it. When false,
   * onboarding waits in its bounded queue; other sends drop.
   */
  isHttpReady: () => boolean;
  /** Socket-derived compute-target identity, or null when the cloud is offline. */
  getComputeTargetId: () => string | null;
  /**
   * ISS-10503 (PRD-736 D5): the first-party desktop session status. The router
   * derives two answers from it, which is why it takes the STATUS and not a
   * boolean: `Authenticated` routes to the authenticated lane (distinct from
   * {@link isHttpReady}, which also requires a compute-target identity — an
   * authenticated install whose target has not resolved waits or drops,
   * never the pre-auth path), and only the TERMINAL signed-out states
   * (`SignedOut` / `RefreshFailed`) rotate the pre-auth identity latches —
   * the sign-in walk's intermediate statuses (opening browser, awaiting
   * redirect, exchanging) are "not authenticated" but must NOT rotate, or the
   * attempt id dies at the exact moment the alias needs it (PR #7768 review).
   */
  getAuthStatus: () => DesktopAuthStatus;
  /**
   * ISS-10503 (PRD-736 D5, decision #10): the install's node_uuid — the
   * single-player PostHog person. Never aliased, never `identify`-ed.
   */
  getNodeUuid: () => string;
  /**
   * ISS-10503 (PRD-736 D5): true when the install runs accountless
   * (single-player operating mode, i.e. no API key). Gates the node_uuid
   * fallback for unauthenticated events that carry no attempt id, so a
   * signed-out MULTIPLAYER install's events stay dropped rather than landing
   * on an anonymous person.
   */
  isSinglePlayerInstall: () => boolean;
  /**
   * ISS-10503 / FEA-2199: whether this launch may make UNAUTHENTICATED
   * pre-auth sends at all — false on unpackaged dev/E2E/CI builds, where a
   * pre-auth POST would hit the default (production) API origin with junk
   * events and inject network activity into guest e2e runs. The authenticated
   * lane needs no such gate because it is scoped by a real session. Resolved
   * once per launch by the shared telemetry egress policy
   * (`preauth-analytics-identity.ts`).
   */
  isPreAuthSendEnabled: () => boolean;
  /**
   * ISS-8687: compute-target identity that SURVIVES a socket drop — bound to the
   * account that owns it (`retained-compute-target-identity.ts`, ISS-8691). Read
   * ONLY for the offline-deliverable analytics family, whose events fire while
   * {@link getComputeTargetId} is null by definition.
   *
   * "Retained" names the GUARANTEE, not the source. The supplied getter is
   * live-else-retained, so it returns the socket-live id whenever there is one
   * and the retained id only once there is not — a superset of a pure retained
   * getter, which does not exist anywhere in this repo. Grepping for one is the
   * dead end this paragraph exists to end.
   *
   * Still null before the first hello of a session, so a client that has never
   * connected reports nothing — there is no identity to attribute the event to,
   * and inventing one is worse than the silence.
   */
  getRetainedComputeTargetId: () => string | null;
};

export type ObservabilityLaneRouter = {
  beginSignInAnalytics(): DesktopSignInAnalytics | null;
  /** Send analytics, buffering onboarding while its authenticated target is pending. */
  sendAnalytics(event: DesktopAnalyticsLaneEvent): void;
  /** Bounded shutdown drain of the analytics HTTP twin's in-flight sends. */
  flushAnalytics(options: { timeoutMs: number }): Promise<void>;
  /** Send one diagnostics-telemetry event over the HTTP twin, or drop it. */
  sendTelemetry(event: DesktopTelemetryLaneEvent): void;
  /**
   * ISS-7496: whether {@link sendTelemetry} would carry an event RIGHT NOW
   * rather than best-effort drop it at the send gate below.
   *
   * Exists for reporters that latch "already reported" once per process. Such a
   * latch set on an ATTEMPT is burned by the first event emitted while the lane
   * is down, and because the drop is silent the alert then never fires again —
   * an operator reads the resulting silence as health. This is the closest
   * thing to a delivery signal the lane has: the send itself is fire-and-forget
   * by design, so a `true` here means "accepted by a ready lane", never
   * "delivered".
   */
  canSendTelemetry(): boolean;
  /** Bounded shutdown drain of the telemetry HTTP twin's in-flight sends. */
  flushTelemetry(options: { timeoutMs: number }): Promise<void>;
  /**
   * Clear the analytics HTTP twin's `feature_disabled` latch so the next send
   * re-evaluates the per-`clerkUserId` gate. Wire to desktop auth-session
   * changes so a disabled verdict for one user never pins analytics off for the
   * next.
   */
  resetForSession(): void;
  refreshAnalyticsReadiness(): void;
  dispose(): void;
};

export function createObservabilityLaneRouter(
  options: ObservabilityLaneRouterOptions
): ObservabilityLaneRouter {
  const laneFetch: SessionFetchOptions & {
    getPluginVersion: () => string;
    onUnauthorized: () => void;
  } = {
    fetch: options.fetch,
    getAccessToken: options.getAccessToken,
    getApiOrigin: options.getApiOrigin,
    getPluginVersion: options.getPluginVersion,
    onUnauthorized: () => {
      // Report BEFORE invalidating: the report rides the keyless relay pipe and
      // needs no token either way, but keeping the order fixed means the signal
      // describes the 401 that was actually observed.
      options.reportAuthFailure?.({
        outcome: AuthOutcome.TokenRejected,
        reason: AuthReason.AccessTokenRejected,
      });
      options.onUnauthorized();
    },
  };
  const analyticsLane = createDesktopAnalyticsHttpLane(laneFetch);
  const telemetryClient = createDesktopTelemetryHttpClient(laneFetch);

  // The send gate: a live session + a known socket-derived identity. Otherwise
  // the event is best-effort dropped (no socket fallback since Phase 4a).
  const readyTargetId = (): string | null => {
    const computeTargetId = options.getComputeTargetId();
    return options.isHttpReady() && computeTargetId ? computeTargetId : null;
  };

  // ISS-8687: the same gate for the offline-deliverable analytics family, but
  // resolving identity from the retained id instead of the socket-live one.
  // `isHttpReady` is unchanged and still ANDed, so a signed-out client sends
  // nothing here either — this loosens WHICH identity may be named, never
  // whether a session is required.
  const retainedReadyTargetId = (): string | null => {
    const computeTargetId = options.getRetainedComputeTargetId();
    return options.isHttpReady() && computeTargetId ? computeTargetId : null;
  };

  const analyticsTargetId = (
    event: DesktopAnalyticsLaneEvent
  ): string | null =>
    isOfflineDeliverableAnalyticsEvent(event.event)
      ? retainedReadyTargetId()
      : readyTargetId();

  // ISS-7496: publish the gate from the module that owns it, so a reporter
  // latching once per process can avoid burning that latch on an event this
  // gate silently dropped. Registered here rather than threaded through the
  // composition root because the gate is this factory's private state and
  // every caller that builds a router wants the same answer.
  setTelemetryDeliverable(() => readyTargetId() !== null);

  // ISS-10503 (PRD-736 D5): pre-auth identity state, derived from the event
  // stream itself so no new IPC is needed. `attemptFlowId` is the live
  // account-bound onboarding attempt's distinct id (= its `flow_id`), held only
  // while the attempt is unauthenticated and not skipped; `accountSkipped`
  // latches at the `skip_account` transition, switching the emission distinct
  // id to node_uuid from that event on (funnel 1b: the skip and everything
  // after it belong to the single-player person; the pre-skip attempt joins
  // via `device_id`). `pendingAliasDistinctId` carries the attempt id onto the
  // first authenticated sends until one is server-acked (invariant 5). All
  // in-memory: after a relaunch an accountless install has no live flow, and
  // the single-player fallback below answers node_uuid without any latch.
  let attemptFlowId: string | null = null;
  let accountSkipped = false;
  let attemptStepIndex: number | null = null;
  let pendingAliasDistinctId: string | null = null;

  const isAuthenticated = (): boolean =>
    options.getAuthStatus() === DesktopAuthStatus.Authenticated;

  const updateAttemptStepIndex = (event: DesktopAnalyticsLaneEvent): void => {
    const step = event.properties?.[OnboardingAnalyticsProperty.Step];
    if (step === OnboardingPhase.Account) {
      const stepIndex =
        event.properties?.[OnboardingAnalyticsProperty.StepIndex];
      // CTA events omit the index; retain the preceding account view's index.
      if (stepIndex !== undefined) {
        attemptStepIndex = typeof stepIndex === "number" ? stepIndex : null;
      }
    } else if (step !== undefined) {
      attemptStepIndex = null;
    }
  };

  const updateAttemptState = (event: DesktopAnalyticsLaneEvent): void => {
    updateAttemptStepIndex(event);
    if (event.event === OnboardingAnalyticsEvent.FlowStarted) {
      accountSkipped = false;
      attemptStepIndex = null;
      // Only an attempt that BEGINS unauthenticated is alias material; an
      // authenticated user's re-onboarding is already captured under their
      // clerkUserId and must not emit a pointless merge.
      attemptFlowId = isAuthenticated() ? null : eventFlowId(event);
      return;
    }
    if (
      event.event === OnboardingAnalyticsEvent.StepSkipped &&
      event.properties?.[OnboardingAnalyticsProperty.Step] ===
        OnboardingPhase.Account
    ) {
      accountSkipped = true;
      // A skipped attempt never authenticates through the flow, so its id is
      // never aliased (PRD-389 §8 keeps the node_uuid person unmerged too).
      attemptFlowId = null;
      return;
    }
    // PR #7768 review: a restored mid-flow run never re-emits flow_started
    // (the flow session is lazily re-minted), so the attempt id is armed from
    // ANY unauthenticated flow-bearing event — otherwise a relaunch at the
    // account step captures pre-auth events that can never be aliased.
    if (!(isAuthenticated() || accountSkipped)) {
      const flowId = eventFlowId(event);
      if (flowId) {
        attemptFlowId = flowId;
      }
    }
  };

  const resolvePreAuthDistinctId = (
    event: DesktopAnalyticsLaneEvent
  ): string | null => {
    const flowId = eventFlowId(event);
    if (!accountSkipped && flowId) {
      return flowId;
    }
    if (accountSkipped || options.isSinglePlayerInstall()) {
      return options.getNodeUuid();
    }
    return null;
  };

  const sendAuthenticated = (
    event: DesktopAnalyticsLaneEvent,
    targetId?: string,
    canStillSend?: () => boolean
  ): void => {
    const computeTargetId = targetId ?? analyticsTargetId(event);
    if (!computeTargetId) {
      return;
    }
    const aliasDistinctId = pendingAliasDistinctId;
    if (!aliasDistinctId) {
      analyticsLane.send(event, computeTargetId, { canStillSend });
      return;
    }
    // Re-presented until one send is acked: the lane is best-effort and a
    // dropped POST must not silently burn the one alias. The server-side alias
    // is idempotent for the same (onboarding id → clerkUserId) pair.
    analyticsLane.send(event, computeTargetId, {
      aliasDistinctId,
      canStillSend,
      onAliasDelivered: () => {
        if (pendingAliasDistinctId === aliasDistinctId) {
          pendingAliasDistinctId = null;
        }
      },
    });
  };

  const onboardingQueue = createOnboardingAnalyticsQueue({
    getIdentity: options.getIdentity,
    getAuthStatus: options.getAuthStatus,
    getApiOrigin: options.getApiOrigin,
    getAppVersion: options.getAppVersion,
    getReadyTarget: readyTargetId,
    send: sendAuthenticated,
  });

  return {
    refreshAnalyticsReadiness: onboardingQueue.refresh,
    dispose: onboardingQueue.dispose,
    beginSignInAnalytics() {
      const flowId = attemptFlowId;
      const stepIndex = attemptStepIndex;
      if (
        !flowId ||
        stepIndex === null ||
        accountSkipped ||
        isAuthenticated()
      ) {
        return null;
      }
      // Snapshot before auth changes rotate the live router state (ISS-11127).
      const properties = {
        [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
        [OnboardingAnalyticsProperty.FlowId]: flowId,
        [OnboardingAnalyticsProperty.DeviceId]: options.getNodeUuid(),
        [OnboardingAnalyticsProperty.Step]: OnboardingPhase.Account,
        [OnboardingAnalyticsProperty.StepIndex]: stepIndex,
        [OnboardingAnalyticsProperty.FirstOrgUser]: FirstOrgUserValue.Unknown,
      };
      return {
        register(codeChallenge) {
          if (options.isPreAuthSendEnabled()) {
            registerDesktopSignInAnalytics(options, {
              codeChallenge,
              flowId,
            }).catch(() => undefined);
          }
        },
        failed(accountMode, reason) {
          if (options.isPreAuthSendEnabled()) {
            analyticsLane.sendPreAuth(
              {
                event: OnboardingAnalyticsEvent.StepFailed,
                occurredAt: new Date().toISOString(),
                properties: {
                  ...properties,
                  [OnboardingAnalyticsProperty.AccountMode]: [...accountMode],
                  [OnboardingAnalyticsProperty.FailureReason]: reason,
                },
              },
              flowId
            );
          }
        },
      };
    },
    sendAnalytics(event) {
      updateAttemptState(event);
      if (isAuthenticated()) {
        if (attemptFlowId) {
          // Freeze the alias at acceptance, before a later flow can replace it.
          pendingAliasDistinctId = attemptFlowId;
          attemptFlowId = null;
        }
        if (isQueuedOnboardingEvent(event)) {
          onboardingQueue.accept(event);
        } else {
          sendAuthenticated(event);
        }
        return;
      }
      // FEA-2199 egress policy: unpackaged launches keep the pre-D5 drop.
      if (!options.isPreAuthSendEnabled()) {
        return;
      }
      const distinctId = resolvePreAuthDistinctId(event);
      if (distinctId) {
        analyticsLane.sendPreAuth(event, distinctId);
      }
    },
    flushAnalytics(flushOptions) {
      onboardingQueue.refresh();
      return analyticsLane.flush(flushOptions);
    },
    canSendTelemetry() {
      return readyTargetId() !== null;
    },
    sendTelemetry(event) {
      const computeTargetId = readyTargetId();
      if (computeTargetId) {
        // Fire-and-forget: the client's returned promise never rejects (it is
        // exposed only so tests and flush can synchronize); telemetry keeps its
        // best-effort class. The `.catch` is a floating-promise guard, not a
        // real error path.
        telemetryClient.send(event, computeTargetId).catch(() => undefined);
      }
    },
    flushTelemetry(flushOptions) {
      return telemetryClient.flush(flushOptions);
    },
    resetForSession() {
      analyticsLane.resetForSession();
      // ISS-10503 (PRD-736 invariant 2): the onboarding id rotates at
      // sign-out. This fires on EVERY auth-session change — including each
      // intermediate status of the sign-in walk (opening browser, awaiting
      // redirect, exchanging), which are "not authenticated" but must not
      // rotate, or the attempt id dies at exactly the account-establishment
      // moment the alias exists for (PR #7768 review). Only the TERMINAL
      // signed-out states rotate: without that, an unacked pending alias held
      // across users on a shared machine would fold user A's pre-auth attempt
      // onto user B's person.
      const status = options.getAuthStatus();
      if (
        status === DesktopAuthStatus.SignedOut ||
        status === DesktopAuthStatus.RefreshFailed
      ) {
        attemptFlowId = null;
        attemptStepIndex = null;
        pendingAliasDistinctId = null;
        accountSkipped = false;
      }
      onboardingQueue.refresh();
    },
  };
}

/**
 * ISS-10503: the event's own attempt id, taken only when it is a well-formed
 * v4 UUID (the same shape the server's injection control enforces — decision
 * #12), so a malformed renderer value can never become a PostHog person.
 */
function eventFlowId(event: DesktopAnalyticsLaneEvent): string | null {
  const flowId = event.properties?.[OnboardingAnalyticsProperty.FlowId];
  return isUuidV4(flowId) ? flowId : null;
}
