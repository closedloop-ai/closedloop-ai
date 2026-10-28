import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import { SESSION_MESH_V1_FEATURE_FLAG_KEY } from "@repo/api/src/types/session-mesh-flag";
import { z } from "zod";
import { readDesktopMainFeatureFlagAssignment } from "../auth/desktop-feature-flag-assignment.js";
import type { SessionMeshDenial } from "./session-mesh-delivery-ledger.js";

/**
 * ISS-11425 — when a Session Mesh client is NOT in the rollout, and how long it
 * waits before asking the cloud again.
 *
 * THE DEFECT THIS CLOSES. The runtime latched a confirmed `session_mesh_disabled`
 * for a flat 60 seconds and then re-probed past its own latch, so an install that
 * was never once allowed still issued one request per minute forever — 1,423
 * `403`s from one install in a day, measured in production on 2026-09-28, against
 * zero `200`s. A fixed latch on a verdict that does not change is a busy-wait.
 *
 * TWO SOURCES OF "OFF", AND THEY ARE NOT INTERCHANGEABLE. The cloud's `403` is an
 * authorization ERROR that happens to carry a rollout verdict, and learning the
 * rollout from it costs a request every time. The account's own PostHog
 * assignment carries the SAME key the server gate evaluates
 * (`SESSION_MESH_V1_FEATURE_FLAG_KEY`), already resolved in this process, and
 * reading it costs nothing — so a positively-evaluated CLOSED verdict stops the
 * local Mesh work and the outbox without discovering the state by being denied.
 *
 * NOTHING HERE EVER GOES PERMANENTLY DARK, and that is what the two ceilings are
 * for. A `403` alone cannot tell "you are not in the rollout" from "the gate
 * could not evaluate the flag" — `isFeatureFlagEnabledForAnyIdentity` folds an
 * unavailable flag service into the same denial — so a denial with no local
 * verdict behind it is capped at
 * {@link SESSION_MESH_DENIAL_UNCONFIRMED_LAST_STEP}, an hour, and a transient
 * cloud outage can cost at most that much. Only a verdict this account's own flag
 * service answered earns the long tail, and even that keeps probing on its
 * schedule, because the assignment is resolved at sign-in and never refreshed
 * mid-session: muting a client on a snapshot with nothing to re-open it would
 * trade the storm for a client that never comes back.
 */

/**
 * Waits between CONSECUTIVE confirmed denials, escalating minutes to hours.
 *
 * The first step is the 60 s the runtime always used: one denial is as likely to
 * be a flag-service blip as a rollout verdict, so the prompt retry is kept and
 * the escalation begins once the cloud has said no twice. It is also the one step
 * left un-jittered, so the existing 60-second recovery contract stays exact; the
 * spread starts where the waits get long enough for convergence to matter.
 */
export const SESSION_MESH_DENIAL_BACKOFF_STEPS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  12 * 60 * 60_000,
];

/**
 * How far a wait is spread either side of its step, as a fraction of it.
 *
 * Applied from the SECOND step on: every install in a denied org escalates on the
 * same schedule, so without a spread they converge on one instant and re-probe
 * together for as long as the org stays out of the rollout.
 */
export const SESSION_MESH_DENIAL_JITTER_RATIO = 0.2;

const LAST_STEP = SESSION_MESH_DENIAL_BACKOFF_STEPS_MS.length - 1;

const DENIAL_BODY = z.object({
  success: z.literal(false),
  code: z.literal("session_mesh_disabled"),
});

/**
 * The furthest a denial with NO local verdict behind it may escalate: an hour.
 *
 * The cloud answers one `403` for "not in the rollout" and for "the flag service
 * could not be read", so an outage long enough to walk an install down this
 * schedule must not be able to black it out for half a day afterwards.
 */
export const SESSION_MESH_DENIAL_UNCONFIRMED_LAST_STEP = 3;

/**
 * The longest wait the DEEPEST step can legitimately produce: that step plus its
 * spread. Only the restart clamp's absolute upper bound; every clamp measures
 * against {@link sessionMeshDenialMaxWaitMs} for the denial's OWN step, because a
 * step-0 wait restored to this one would park an install for half a day on a
 * ceiling its own step can never reach.
 */
export const SESSION_MESH_DENIAL_MAX_WAIT_MS =
  sessionMeshDenialMaxWaitMs(LAST_STEP);

export type SessionMeshDenialClock = {
  now: number;
  /**
   * Injectable so this module's OWN suite can pin a jittered schedule instead of
   * sampling it. Production call sites pass only `now`; a runtime-level suite
   * asserts against the spread's bounds rather than an exact instant.
   */
  random?: () => number;
};

function stepDelayMs(step: number): number {
  const index = Math.min(Math.max(Math.trunc(step), 0), LAST_STEP);
  return SESSION_MESH_DENIAL_BACKOFF_STEPS_MS[index];
}

function waitMs(step: number, random: () => number): number {
  const delayMs = stepDelayMs(step);
  if (step <= 0) {
    return delayMs;
  }
  const spreadMs = delayMs * SESSION_MESH_DENIAL_JITTER_RATIO;
  return Math.round(delayMs - spreadMs + random() * 2 * spreadMs);
}

/**
 * The evaluated verdict for the Mesh key, or `undefined` when there is none.
 *
 * NO SUBJECT COMPARISON IS NEEDED HERE, though the verdict is account-scoped and
 * Mesh's own key is not. `resolveFor` clears the store SYNCHRONOUSLY on an
 * account boundary, so the previous account's verdict is never `Assigned` once
 * the identity Mesh reads has moved — both read the same session manager. A
 * mismatch would therefore have to be a store that settled for an account this
 * process is not signed into, which nothing can produce.
 */
function assignedVerdict(): boolean | undefined {
  const assignment = readDesktopMainFeatureFlagAssignment();
  if (assignment?.delivery !== FeatureAssignmentDelivery.Assigned) {
    return undefined;
  }
  return assignment.flags[SESSION_MESH_V1_FEATURE_FLAG_KEY];
}

/**
 * Whether this account's own PostHog assignment says Session Mesh is OFF.
 *
 * THE KEY MUST BE PRESENT AND `false`, and that is not pedantry. `flags` holds
 * only the keys the flag service ANSWERED for, and an absent key is documented
 * UNKNOWN (`packages/api/src/types/desktop-feature-flags.ts`) — the flag
 * service's own server client resolves its request failures to an empty record
 * that still reports `resolved`, so a failed read arrives here as an `Assigned`
 * delivery with no keys (`packages/analytics/feature-flags.ts`, its KNOWN LIMIT
 * comment names the client). Reading that as
 * "evaluated, not enrolled" would suppress Mesh for an ENROLLED account on one
 * bad read. Absent falls through to the probe, where the server decides.
 */
export function isSessionMeshAssignmentClosed(): boolean {
  return assignedVerdict() === false;
}

/**
 * Whether this account's own PostHog assignment says Session Mesh is ON.
 *
 * Not the negation of {@link isSessionMeshAssignmentClosed}: an unanswered key and
 * every non-answer delivery are NEITHER. Used to NAME a disagreement with the
 * cloud gate, never to grant access.
 */
export function isSessionMeshAssignmentOpen(): boolean {
  return assignedVerdict() === true;
}

/**
 * Whether a `403` body is the cloud's authoritative "not in the rollout".
 *
 * NARROW ON PURPOSE, IN BOTH DIRECTIONS. A body this build cannot parse, or one
 * carrying a different code, is a version-skewed or unrelated authorization
 * failure and must never latch a rollout verdict. Extra keys a newer server adds
 * DO still latch: the schema strips what it does not know rather than rejecting
 * the payload, which is the degrade-gracefully direction this repo's version-skew
 * rule asks for. Shipped Desktop builds latch on exactly this status-and-code
 * pair, which is why `apps/api/app/session-mesh/auth.ts` still answers `403`.
 */
export function isSessionMeshDenialBody(text: string): boolean {
  try {
    return DENIAL_BODY.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/**
 * The denial to record after the cloud confirms `session_mesh_disabled`: one step
 * further out than the denial this source already carried, or the first step when
 * this is a new source.
 *
 * The ceiling depends on the EVIDENCE, not on how many times the cloud has said
 * no — see {@link SESSION_MESH_DENIAL_UNCONFIRMED_LAST_STEP}.
 */
export function escalateSessionMeshDenial(
  previous: SessionMeshDenial | null,
  sourceKey: string,
  clock: SessionMeshDenialClock
): SessionMeshDenial {
  const ceiling = isSessionMeshAssignmentClosed()
    ? LAST_STEP
    : SESSION_MESH_DENIAL_UNCONFIRMED_LAST_STEP;
  const step =
    previous?.sourceKey === sourceKey
      ? Math.min(previous.step + 1, ceiling)
      : 0;
  return {
    sourceKey,
    step,
    retryAt: clock.now + waitMs(step, clock.random ?? Math.random),
  };
}

/**
 * Re-arm the CURRENT step before a probe is sent.
 *
 * A probe that never answers — a hang, a network failure, a reply the runtime
 * rejects — is not a confirmed denial and must not escalate, but it must also not
 * leave `retryAt` in the past, which would re-probe on the very next 5 s tick and
 * reproduce the storm through the failure path.
 */
export function rearmSessionMeshDenial(
  denial: SessionMeshDenial,
  clock: SessionMeshDenialClock
): SessionMeshDenial {
  return {
    ...denial,
    retryAt: clock.now + waitMs(denial.step, clock.random ?? Math.random),
  };
}

/** Whether `sourceKey` may probe now. An unrelated or absent denial never defers. */
export function isSessionMeshProbeDue(
  denial: SessionMeshDenial | null,
  sourceKey: string,
  now: number
): boolean {
  if (denial?.sourceKey !== sourceKey) {
    return true;
  }
  if (now >= denial.retryAt) {
    return true;
  }
  // A backward system-clock jump mid-session would otherwise park this wait out
  // of reach until the next restart, where `restoreSessionMeshDenial` clamps it.
  // Probing is the safe direction: the probe re-arms a wait this clock can reach.
  return denial.retryAt - now > sessionMeshDenialMaxWaitMs(denial.step);
}

/**
 * Clamp a denial read back off disk to a wait this clock can still reach.
 *
 * A ledger written before a clock correction (or on another machine) can carry a
 * `retryAt` arbitrarily far in the future, which would disable Mesh for an
 * enrolled account with nothing to clear it. The bound is THIS denial's own step
 * — {@link sessionMeshDenialMaxWaitMs} — not the deepest step's: clamping a
 * step-0 or an unconfirmed step-3 denial to the global ceiling turned a minute
 * into fourteen hours and broke the hour this policy's header promises a
 * transient outage can cost.
 */
export function restoreSessionMeshDenial(
  denial: SessionMeshDenial | null | undefined,
  now: number
): SessionMeshDenial | null {
  if (!denial) {
    return null;
  }
  const ceiling = now + sessionMeshDenialMaxWaitMs(denial.step);
  if (denial.retryAt > ceiling) {
    return { ...denial, retryAt: ceiling };
  }
  return denial;
}

/**
 * The longest wait `step` can legitimately produce: its delay plus its spread.
 *
 * Anything beyond it did not come from this policy at that step, so the restart
 * clamp and the mid-session clock-jump check both measure against it. Step 0 is
 * un-jittered, so its bound is the bare delay — and a jittered later step sits up
 * to 20% above its own delay, which must NOT read as impossible or every such
 * wait re-probes immediately.
 */
export function sessionMeshDenialMaxWaitMs(step: number): number {
  const delayMs = stepDelayMs(step);
  if (step <= 0) {
    return delayMs;
  }
  return delayMs * (1 + SESSION_MESH_DENIAL_JITTER_RATIO);
}
