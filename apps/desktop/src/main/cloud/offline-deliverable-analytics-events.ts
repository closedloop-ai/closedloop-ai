/**
 * @file offline-deliverable-analytics-events.ts
 * @description ISS-8687: which product-analytics events may be sent under the
 * RETAINED compute-target identity rather than the socket-live one.
 *
 * The observability lanes gate every send on a socket-derived compute-target id
 * (`observability-lane-router.ts`). `desktop_connection_lost` and
 * `desktop_connection_degraded` fire precisely when that socket is down, so the
 * events that describe losing the connection were events the transport could
 * never carry. `gridview_rollout_decision` carries the same class of diagnostic
 * non-answer for rollout delivery: a socket-down desktop is a rollout datapoint,
 * not a reason to drop the row that says the assignment path could not answer.
 *
 * A socket drop is NOT a network outage, which is what makes this fixable at
 * all: the analytics lane is an ordinary authenticated HTTPS POST and does not
 * ride the socket. In the 2026-08-31 incident the customer's HTTP path was
 * healthy throughout while the relay tore their socket down every ~15 minutes on
 * `ping timeout` — so the send would have succeeded on every one of those 72
 * drops. Under the retained id these events are attempted rather than dropped;
 * when the network really is down the POST simply fails, which is the lane's
 * existing best-effort class and costs nothing extra.
 *
 * Deliberately NOT a blanket widening of the gate. The gate exists so that
 * best-effort events do not pile up attempts while offline, and most analytics
 * events have no reason to be emitted then. This table names the exception.
 *
 * ## Why an exhaustive Record and not a small Set of names
 * A `ReadonlySet<DesktopAnalyticsEventName>` listing the exceptions would compile
 * unchanged when a new event name is added, and the new event would silently
 * inherit the strict-online gate — which is exactly the defect this file exists
 * to fix, reintroduced one event at a time. The Record below cannot be written
 * without naming every member, so a new `DesktopAnalyticsEventName` fails
 * `tsc` here until someone decides whether it is emitted while the socket is
 * down (root `AGENTS.md`, "Review Lessons": a side inventory of a union loses
 * the exhaustiveness a switch would have had).
 *
 * `false` is the right default for a new event, but it must be a CHOSEN false.
 */
import { DesktopAnalyticsEventName } from "@repo/api/src/types/desktop-analytics";

/**
 * Whether the event is emitted at a moment when the cloud socket is, by
 * definition, not online — and therefore must resolve its compute target from
 * the retained identity or not be sent at all.
 *
 * `desktop_connection_established` / `desktop_reconnection_resumed` are `false`
 * on purpose: ISS-7710 moved them onto the applied-online branch, so the
 * socket-live id is available when they fire and nothing is gained by loosening
 * them.
 */
const OFFLINE_DELIVERABLE_ANALYTICS_EVENT: Record<
  DesktopAnalyticsEventName,
  boolean
> = {
  [DesktopAnalyticsEventName.AgentSessionSyncBatchFailed]: false,
  [DesktopAnalyticsEventName.CommandInitiated]: false,
  [DesktopAnalyticsEventName.CommandStarted]: false,
  [DesktopAnalyticsEventName.CommandCompleted]: false,
  [DesktopAnalyticsEventName.CommandFailed]: false,
  [DesktopAnalyticsEventName.ApprovalRequested]: false,
  [DesktopAnalyticsEventName.ApprovalResolved]: false,
  [DesktopAnalyticsEventName.DesktopConnectionEstablished]: false,
  [DesktopAnalyticsEventName.DesktopReconnectionResumed]: false,
  [DesktopAnalyticsEventName.DesktopConnectionDegraded]: true,
  [DesktopAnalyticsEventName.DesktopConnectionLost]: true,
  [DesktopAnalyticsEventName.DesktopPopUnavailable]: false,
  [DesktopAnalyticsEventName.PluginUpdateAttempted]: false,
  [DesktopAnalyticsEventName.PluginUpdateSucceeded]: false,
  [DesktopAnalyticsEventName.PluginUpdateFailed]: false,
  [DesktopAnalyticsEventName.SandboxBlockedOperation]: false,
  [DesktopAnalyticsEventName.HealthcheckFailureDetected]: false,
  [DesktopAnalyticsEventName.HealthcheckFailurePersistent]: false,
  [DesktopAnalyticsEventName.HealthcheckRecovered]: false,
  [DesktopAnalyticsEventName.SharedComponentRendered]: false,
  [DesktopAnalyticsEventName.GridviewRolloutDecision]: true,
  // ISS-10502: the FTUE onboarding catalog is CHOSEN false. These are ordinary
  // product events, not socket-down diagnostics — none fires because the socket
  // dropped. A pre-auth fresh install has no retained identity for this table
  // to fall back to anyway; pre-auth delivery is the router's ISS-10503
  // pre-auth path (client-supplied distinct id), not a lane-gate exception.
  [DesktopAnalyticsEventName.FlowStarted]: false,
  [DesktopAnalyticsEventName.StepViewed]: false,
  [DesktopAnalyticsEventName.StepCompleted]: false,
  [DesktopAnalyticsEventName.StepFailed]: false,
  [DesktopAnalyticsEventName.StepSkipped]: false,
  [DesktopAnalyticsEventName.StepBack]: false,
  [DesktopAnalyticsEventName.CtaClicked]: false,
  [DesktopAnalyticsEventName.FlowCompleted]: false,
  [DesktopAnalyticsEventName.TourStarted]: false,
  [DesktopAnalyticsEventName.TourStepViewed]: false,
  [DesktopAnalyticsEventName.TourCompleted]: false,
  [DesktopAnalyticsEventName.TourSkipped]: false,
  [DesktopAnalyticsEventName.ChecklistItemCompleted]: false,
  [DesktopAnalyticsEventName.ChecklistCompleted]: false,
  [DesktopAnalyticsEventName.PageViewed]: false,
  [DesktopAnalyticsEventName.ButtonClicked]: false,
};

/**
 * Whether `event` may fall back to the retained compute-target identity when the
 * socket-live one is unavailable. An event name this build does not know is
 * treated as strict-online — the closed, current behavior.
 */
export function isOfflineDeliverableAnalyticsEvent(
  event: DesktopAnalyticsEventName
): boolean {
  return OFFLINE_DELIVERABLE_ANALYTICS_EVENT[event] === true;
}
