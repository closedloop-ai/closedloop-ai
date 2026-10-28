import { useEffect, useState } from "react";
import { exponentialBackoffMs } from "../../shared/exponential-backoff";
import {
  RENDERER_WINDOW_GONE_MESSAGE,
  UNTRUSTED_IPC_SENDER_MESSAGE,
} from "../../shared/ipc-refusal-messages";
import type { OnboardingLocalStateWire } from "../../shared/onboarding-local-state-contract";
import { parseOnboardingLocalState } from "../../shared/onboarding-local-state-parse";
import { cleanIpcError } from "../clean-ipc-error";

/** Normal poll cadence, and the base delay of the failure ladder. */
export const ONBOARDING_LOCAL_STATE_POLL_MS = 5000;

/** Ceiling of the failure ladder: 5s → 10s → 20s → 40s → 60s → 60s … */
export const ONBOARDING_LOCAL_STATE_BACKOFF_MAX_MS = 60_000;

/**
 * What the adapter knows.
 *
 * Five terminal shapes rather than one `unavailable`, because the acceptance
 * criterion requires loading, unavailable, forbidden, partial and error to stay
 * distinct — and because collapsing them changes behavior, not just wording:
 * an authorization refusal retried on a backoff ladder is a permanent condition
 * being asked again forever.
 *
 * `partial` is deliberately NOT here. It is a property of the DATA — the
 * inventory's own `parseCompleteness` — not of the read, and putting it on this
 * axis would conflate "we could not read" with "we read, and the measurement is
 * short".
 */
export type OnboardingLocalStateRead =
  /** No answer yet. Never rendered as a zero. */
  | { state: "loading" }
  /** No preload bridge at all — an older shell, or a non-Electron host. */
  | { state: "bridge-absent" }
  /** The sender was refused. Permanent for this renderer; no retry. */
  | { state: "forbidden" }
  /** The window is being torn down. A lifecycle race, not a refusal. */
  | { state: "window-gone" }
  /** A transient read failure. Retried on the ladder. */
  | { state: "failed" }
  | { state: "ready"; snapshot: OnboardingLocalStateWire };

/**
 * Which terminal state a rejected invoke means.
 *
 * Electron wraps a handler's throw, so the underlying text is recovered with
 * `cleanIpcError` and compared against the IMPORTED constants — a hand-written
 * literal here would drift the moment either message changed. The two refusals
 * are kept apart on purpose (ISS-8776: "a DIFFERENT FACT, not a softer one"):
 * calling a teardown race an authorization refusal reports an attack that is not
 * happening, and retrying a real refusal forever asks a settled question again.
 */
function classifyReadFailure(
  error: unknown
): "forbidden" | "window-gone" | "failed" {
  const message = cleanIpcError(error, "");
  if (message === UNTRUSTED_IPC_SENDER_MESSAGE) {
    return "forbidden";
  }
  if (message === RENDERER_WINDOW_GONE_MESSAGE) {
    return "window-gone";
  }
  return "failed";
}

/**
 * Whether an arriving snapshot still describes the read we are waiting for.
 *
 * Ordered by the monotone inventory revision, and scoped to this onboarding run
 * by the echoed attempt. An ABSENT attempt on either side is never a mismatch:
 * onboarding genuinely runs before an attempt exists, so rejecting on absence
 * would drop every early answer.
 */
function describesCurrentRead(
  snapshot: OnboardingLocalStateWire,
  requestedAttemptId: string | undefined,
  heldRevision: number
): boolean {
  // A revision that went BACKWARDS is a reply from a superseded sweep — the
  // inventory revision is monotone, and the pre-sweep sentinel is below every
  // minted value, so it only ever climbs.
  if (snapshot.analysisEta.inventoryRevision < heldRevision) {
    return false;
  }
  // Identity is deliberately NOT a rejection axis on its own. The main process
  // reads the CURRENT identity on every read, so after a sign-in or an account
  // switch every response legitimately carries a new id; dropping those would
  // freeze the hook on a stale snapshot for the rest of the session. The
  // revision above is what actually orders replies, and the attempt below is
  // what scopes them to this onboarding run.
  return !(
    snapshot.attemptId !== undefined &&
    requestedAttemptId !== undefined &&
    snapshot.attemptId !== requestedAttemptId
  );
}

/**
 * ISS-8376: poll the desktop-local onboarding facts — the transcript byte
 * inventory and the analysis ETA.
 *
 * `active` is not optional bookkeeping. The onboarding shell keeps steps
 * mounted, so an ungated poller would run an IPC round trip every 5s for the
 * whole session; the caller passes whether the step is actually on screen, and
 * the poll lives exactly that long.
 *
 * The main-process sweep behind this read is one-shot and runs off-thread, so
 * polling costs a message round trip and never a filesystem walk.
 */
export function useOnboardingLocalState(
  active: boolean,
  attemptId?: string
): OnboardingLocalStateRead {
  const [read, setRead] = useState<OnboardingLocalStateRead>({
    state: "loading",
  });

  useEffect(() => {
    if (!active) {
      // Drop back to `loading` rather than holding the last value: when the step
      // is shown again it must not flash a settled state read minutes ago.
      setRead({ state: "loading" });
      return;
    }
    setRead({ state: "loading" });
    return startOnboardingLocalStatePoll(setRead, attemptId);
  }, [active, attemptId]);

  return read;
}

function nextDelay(consecutiveFailures: number): number {
  return exponentialBackoffMs(
    consecutiveFailures,
    ONBOARDING_LOCAL_STATE_POLL_MS,
    ONBOARDING_LOCAL_STATE_BACKOFF_MAX_MS
  );
}

/**
 * The poll loop, hoisted out of the effect so each step is a flat function
 * rather than another level of nesting inside it.
 *
 * Returns the teardown the effect hands back: it flips `cancelled`, which every
 * post-await path checks, and clears the pending timer.
 */
function startOnboardingLocalStatePoll(
  setRead: (next: OnboardingLocalStateRead) => void,
  attemptId: string | undefined
): () => void {
  let cancelled = false;
  let inFlight = false;
  let consecutiveFailures = 0;
  let heldRevision = 0;
  let timer: number | undefined;

  const schedule = (delayMs: number): void => {
    timer = window.setTimeout(kick, delayMs);
  };

  const reportTransientFailure = (): void => {
    consecutiveFailures += 1;
    setRead({ state: "failed" });
    schedule(nextDelay(consecutiveFailures));
  };

  /** A read that returned. Decides whether it is ours, then reports it. */
  const accept = (raw: unknown): void => {
    const snapshot = parseOnboardingLocalState(raw);
    if (!snapshot) {
      reportTransientFailure();
      return;
    }
    if (!describesCurrentRead(snapshot, attemptId, heldRevision)) {
      // A late reply from a superseded sweep or a prior attempt. Drop it, keep
      // the cadence — the next poll answers for the current one.
      schedule(ONBOARDING_LOCAL_STATE_POLL_MS);
      return;
    }
    heldRevision = snapshot.analysisEta.inventoryRevision;
    consecutiveFailures = 0;
    setRead({ state: "ready", snapshot });
    schedule(ONBOARDING_LOCAL_STATE_POLL_MS);
  };

  /** A read that threw. A settled refusal is never retried. */
  const reject = (error: unknown): void => {
    const failure = classifyReadFailure(error);
    if (failure === "failed") {
      reportTransientFailure();
      return;
    }
    // A refusal and a teardown are both settled facts. Retrying either asks a
    // question that has already been answered.
    setRead({ state: failure });
  };

  async function run(): Promise<void> {
    if (cancelled || inFlight) {
      return;
    }
    const getState = window.desktopApi?.getOnboardingLocalState;
    if (!getState) {
      // Nothing to retry toward — settle rather than climbing the ladder.
      setRead({ state: "bridge-absent" });
      return;
    }
    inFlight = true;
    try {
      const raw = await getState(attemptId ? { attemptId } : undefined);
      // Checked AFTER the await: a read that resolves post-unmount must not set
      // state, and one that resolves after the identity moved must not be
      // merged into the current attempt.
      if (!cancelled) {
        accept(raw);
      }
    } catch (error) {
      if (!cancelled) {
        reject(error);
      }
    } finally {
      inFlight = false;
    }
  }

  /**
   * Start a poll without returning its promise. `run` owns its own rejections,
   * so this only guards an unexpected throw — a status read must never surface
   * as an unhandled rejection.
   */
  function kick(): void {
    run().catch(() => {
      // Intentionally inert; `run`'s own catch owns the retry ladder.
    });
  }

  kick();

  return () => {
    cancelled = true;
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  };
}
