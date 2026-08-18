import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CloudReadReadinessSnapshot,
  cloudReadReadinessFingerprint,
} from "../../shared/cloud-read-readiness-contract";
import { DesktopAuthStatus } from "../../shared/contracts";
import { exponentialBackoffMs } from "../../shared/exponential-backoff";
import { parseCloudReadReadinessSnapshot } from "../hooks/parse-cloud-read-readiness";
import {
  type CloudReadCutoverDecision,
  CloudReadCutoverLatch,
  resolveCloudReadCutover,
} from "./desktop-app-core-mode";

/** Normal poll cadence while the reader is waiting, and the failure ladder's base. */
export const CLOUD_READ_READINESS_POLL_MS = 5000;

/** Ceiling of the failure ladder: 5s → 10s → 20s → 40s → 60s → 60s … */
export const CLOUD_READ_READINESS_BACKOFF_MAX_MS = 60_000;

/** Who a cutover measurement belongs to. */
export type CloudReadCutoverIdentity = {
  /** Live main-process auth status, mirrored by `DesktopAuthProvider`. */
  status: DesktopAuthStatus;
  userId: string | null;
  organizationId: string | null;
};

/**
 * ISS-5714 (review thread): the identity a cutover measurement is ABOUT, or
 * `null` when there is no durable session to measure for.
 *
 * The backlog question — "does the cloud hold this machine's history?" — is only
 * ever answered for one workspace. Token application can move the renderer
 * straight from authenticated org A to authenticated org B without passing
 * through a signed-out status, so keying this state on `status` alone let B
 * inherit A's drained latch: polling stayed torn down (the latch is what stops
 * it), the gate never re-ran, and Branches read B's cloud before B's backlog was
 * established — the exact empty-workspace symptom this ticket closed, one org
 * over.
 *
 * The ORGANIZATION is part of the key even though {@link resolveCloudReadCutover}
 * never reads it: the cloud corpus a cutover licenses reading is org-scoped, and
 * `canonicalBranchesIdentityKey` (the Branches consumer of this decision) already
 * requires one. A user id alone would let an org switch reuse a measurement
 * taken against a different workspace's backlog.
 *
 * `null` for every non-`authenticated` status, matching the rule in
 * `resolveCloudReadCutover`: those states cannot reach the cloud at all, so a
 * measurement cannot belong to them. That also makes sign-out a key change, so
 * one mechanism drops the session's state instead of two.
 */
export function cloudReadCutoverIdentityKey(
  identity: CloudReadCutoverIdentity
): string | null {
  if (identity.status !== DesktopAuthStatus.Authenticated) {
    return null;
  }
  // Serialized as a pair rather than concatenated, so no two id pairs can
  // collide by straddling a separator. Same shape as
  // `canonicalBranchesIdentityKey`, the Branches consumer of this decision.
  return JSON.stringify([identity.userId, identity.organizationId]);
}

/**
 * Everything this hook has LEARNED, stamped with the identity it was learned
 * for. Read back only on a key match, so a measurement can never be applied to
 * the account that follows it.
 */
type CloudReadCutoverObservation = {
  identityKey: string | null;
  readiness: CloudReadReadinessSnapshot | null;
  readinessUnavailable: boolean;
  unchangedForMs: number | null;
};

/** Nothing established yet — the state every new identity starts from. */
const NO_OBSERVATION: CloudReadCutoverObservation = {
  identityKey: null,
  readiness: null,
  readinessUnavailable: false,
  unchangedForMs: null,
};

/** The stall clock, likewise stamped with whose backlog it is timing. */
type CloudReadCutoverClock = {
  identityKey: string | null;
  fingerprint: string | null;
  changedAt: number | null;
};

/**
 * ISS-5477: the live read-source decision — should this renderer read its own
 * machine's data, or the cloud?
 *
 * Polls the main process for the ISS-5387 burn-down's readiness projection and
 * feeds it, with the hysteresis latch and the stall clock, into the pure
 * {@link resolveCloudReadCutover}. Everything that decides anything lives in
 * that pure function; this hook only supplies it with live inputs.
 *
 * **Every input is scoped to the identity it was measured for.** See
 * {@link cloudReadCutoverIdentityKey}: the latch, the last reading, and the
 * stall clock are all read back only when their key still matches the current
 * one, so a direct authenticated→authenticated account switch re-arms the full
 * gate rather than inheriting the previous session's answer. The match is
 * evaluated DURING RENDER rather than repaired from an effect: on a switch the
 * inherited latch would otherwise decide one render, and one render on the cloud
 * is one render of the wrong workspace.
 *
 * **It costs nothing until it can do anything.** Polling runs only while the
 * user is authenticated AND the decision is still live — signed out there is
 * nothing to hold, and once the decision latches (a genuine drain, or the
 * bounded fail-open) the answer cannot change back, so the timer is torn down
 * rather than left running for the session. A renderer whose preload predates
 * this channel reports the channel unavailable and polls once, never again.
 *
 * **A failed read is not progress.** The clock that drives the fail-open keeps
 * running across failures instead of resetting: an unreadable readiness signal
 * is exactly the wedge the bound exists to escape, so it must count toward it.
 */
export function useCloudReadCutover(
  input: CloudReadCutoverIdentity & { isOnline: boolean }
): CloudReadCutoverDecision {
  const { status, isOnline } = input;
  const identityKey = cloudReadCutoverIdentityKey(input);
  const [observed, setObserved] =
    useState<CloudReadCutoverObservation>(NO_OBSERVATION);
  const latchRef = useRef<{
    identityKey: string | null;
    latch: CloudReadCutoverLatch;
  }>({ identityKey, latch: CloudReadCutoverLatch.None });
  const clockRef = useRef<CloudReadCutoverClock>({
    identityKey,
    fingerprint: null,
    changedAt: null,
  });

  // Whose measurement is this? A stale one is not merely ignored on the next
  // tick — it is never read at all.
  const observation =
    observed.identityKey === identityKey ? observed : NO_OBSERVATION;
  const latch =
    latchRef.current.identityKey === identityKey
      ? latchRef.current.latch
      : CloudReadCutoverLatch.None;

  const decision = resolveCloudReadCutover({
    status,
    isOnline,
    readiness: observation.readiness,
    readinessUnavailable: observation.readinessUnavailable,
    latch,
    unchangedForMs: observation.unchangedForMs,
  });

  // Carry the latch, and whose it is, into the next evaluation. Written from an
  // effect rather than during render so the render stays pure; a one-render lag
  // is safe because the value can only move AWAY from `None` here — every path
  // that drops it back (sign-out, account switch) is the identity mismatch read
  // above, which applies during render.
  useEffect(() => {
    latchRef.current = { identityKey, latch: decision.latch };
  }, [identityKey, decision.latch]);

  /** The stall clock for the CURRENT identity, re-armed if it belongs to a prior one. */
  const currentClock = useCallback((): CloudReadCutoverClock => {
    if (clockRef.current.identityKey !== identityKey) {
      clockRef.current = { identityKey, fingerprint: null, changedAt: null };
    }
    return clockRef.current;
  }, [identityKey]);

  /** Merge a reading into THIS identity's observation, discarding any prior one. */
  const applyObservation = useCallback(
    (patch: Partial<Omit<CloudReadCutoverObservation, "identityKey">>) => {
      setObserved((prior) => ({
        ...(prior.identityKey === identityKey ? prior : NO_OBSERVATION),
        ...patch,
        identityKey,
      }));
    },
    [identityKey]
  );

  const observe = useCallback(
    (snapshot: CloudReadReadinessSnapshot) => {
      const clock = currentClock();
      const fingerprint = cloudReadReadinessFingerprint(snapshot);
      const now = Date.now();
      if (clock.fingerprint !== fingerprint || clock.changedAt === null) {
        clock.fingerprint = fingerprint;
        clock.changedAt = now;
      }
      applyObservation({
        readiness: snapshot,
        unchangedForMs: now - clock.changedAt,
      });
    },
    [applyObservation, currentClock]
  );

  const observeUnreadable = useCallback(() => {
    const clock = currentClock();
    const now = Date.now();
    if (clock.changedAt === null) {
      clock.changedAt = now;
    }
    applyObservation({ unchangedForMs: now - clock.changedAt });
  }, [applyObservation, currentClock]);

  const observeChannelUnavailable = useCallback(() => {
    applyObservation({ readinessUnavailable: true });
  }, [applyObservation]);

  // Nothing to gate while signed out, and nothing left to learn once THIS
  // identity has latched.
  const polling =
    status === DesktopAuthStatus.Authenticated &&
    latch === CloudReadCutoverLatch.None;

  useEffect(() => {
    if (!polling) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let consecutiveFailures = 0;
    let timer: number | undefined;

    // Function declarations (not consts) so the mutual reference between
    // `schedule`, `kick` and `run` needs no forward declaration — the same shape
    // as `use-transcript-sync-status.ts`.
    function schedule(delayMs: number): void {
      timer = window.setTimeout(kick, delayMs);
    }

    /**
     * Start a poll without returning its promise. `run` owns its own rejections;
     * this handler only guards an unexpected throw, because a read-source probe
     * must never surface as an unhandled rejection.
     */
    function kick(): void {
      run().catch(() => {
        // Intentionally inert; `run`'s own catch owns the retry ladder.
      });
    }

    /**
     * A poll that produced no usable snapshot — the read rejected, or it
     * resolved with something that is not a readiness snapshot. Both are the
     * same fact about this channel, so they share one ladder: the stall clock
     * keeps running (an unreadable signal is exactly the wedge the bounded
     * fail-open exists to escape) and the next attempt backs off.
     */
    function failRead(): void {
      consecutiveFailures += 1;
      observeUnreadable();
      schedule(
        exponentialBackoffMs(
          consecutiveFailures,
          CLOUD_READ_READINESS_POLL_MS,
          CLOUD_READ_READINESS_BACKOFF_MAX_MS
        )
      );
    }

    /** Land one validated read, or route an unusable one into the ladder. */
    function applyRead(snapshot: CloudReadReadinessSnapshot | null): void {
      if (snapshot === null) {
        failRead();
        return;
      }
      consecutiveFailures = 0;
      observe(snapshot);
      schedule(CLOUD_READ_READINESS_POLL_MS);
    }

    async function run(): Promise<void> {
      if (cancelled || inFlight) {
        return;
      }
      const read = window.desktopApi?.getCloudReadReadiness;
      if (!read) {
        // A preload without this channel cannot answer, and waiting on an
        // answer that can never arrive would hold every such renderer on Local.
        // Report the channel as unavailable so the pre-channel behaviour applies
        // immediately, and stop polling.
        observeChannelUnavailable();
        return;
      }
      inFlight = true;
      try {
        // ISS-6206 (wongk review on #5050): VALIDATED, not asserted. The
        // preload's declared return type is a claim, not a runtime check, and
        // `resolveBacklogBlocker` only iterates the lanes it is handed — so a
        // truncated one-lane drained payload used to cut this renderer over to
        // the cloud and take the user's local history off the screen.
        const snapshot = parseCloudReadReadinessSnapshot(await read());
        if (!cancelled) {
          applyRead(snapshot);
        }
      } catch {
        if (!cancelled) {
          failRead();
        }
      } finally {
        inFlight = false;
      }
    }

    kick();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
    // `observe` / `observeUnreadable` / `observeChannelUnavailable` are keyed on
    // the identity, so an account switch tears this poll loop down and starts a
    // fresh one against the new workspace rather than letting an in-flight read
    // land on it.
  }, [polling, observe, observeUnreadable, observeChannelUnavailable]);

  return decision;
}
