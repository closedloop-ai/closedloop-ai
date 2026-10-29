import { readFeatureAssignment } from "@repo/api/src/types/feature-assignment-boundary";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import {
  resolveDesktopMainDevModeOverride,
  subscribeToDesktopMainDevModeVerdicts,
} from "./desktop-feature-flag-dev-mode.js";

/**
 * ISS-9437 — the MAIN process's own view of the signed-in account's PostHog
 * flag assignment.
 *
 * WHY MAIN NEEDS ITS OWN. Main is a flag CONSUMER in its own right: it builds
 * the desktop Branches server page (`shared-branches-list-result.ts`), and that
 * page's row order has to be decided before any renderer asks for it. The
 * renderer's assignment lives in React state behind
 * `DesktopFeatureFlagsIpcChannel.Get`, so reading it from main would mean main
 * waiting on the renderer to have asked — a race whose loser serves a page in
 * the wrong order and never corrects it. This resolves on main's OWN auth
 * lifecycle instead, from the same endpoint, for the same account.
 *
 * FAIL-CLOSED. Unresolved is CLOSED, and so is every terminal non-answer:
 * signed out, a transport failure, a malformed payload, an assignment evaluated
 * for a different account. Nothing here reads the build type — a developer's
 * unpackaged machine gets exactly the packaged answer.
 *
 * ACCOUNT-CORRELATED, the way the renderer correlates
 * (`desktop-posthog-flag-assignment.ts`): the subject travels WITH the verdict,
 * a reply is adopted only when it belongs to the account it was requested for,
 * and the store is cleared the instant the account changes — so one account's
 * gates can never be read for the next one, not even for the window in which
 * the new lookup is still in flight.
 */
export type DesktopMainFeatureFlagAssignment = {
  /** WHO this verdict was evaluated for; `null` when no account is signed in. */
  subject: string | null;
  /** Per-key verdicts, and only for a delivery that actually assigned them. */
  flags: Readonly<Record<string, boolean>>;
  delivery: FeatureAssignmentDelivery;
  /** ISS-12552: the keys the service answered for the organization. */
  organizationEvaluated?: readonly string[];
};

export type DesktopMainFeatureFlagAssignmentStore = {
  /**
   * Point the store at an account and resolve its assignment.
   *
   * Clears synchronously first, so the window between the account changing and
   * its assignment arriving reads CLOSED rather than reading the previous
   * account's verdicts. Returns the in-flight read so a caller (a test, or a
   * startup path that wants to await it) can join; production callers fire and
   * forget, because every consumer already treats unresolved as closed.
   */
  resolveFor(subject: string | null): Promise<void>;
  /** The current verdict for one key. Unresolved and unknown are both `false`. */
  isEnabled(key: string): boolean;
  /** The whole current assignment, for diagnostics and tests. */
  read(): DesktopMainFeatureFlagAssignment;
  /**
   * ISS-8792 — run `listener` every time a verdict SETTLES, and return the
   * unsubscribe.
   *
   * A main consumer that reads the store at a fixed moment (a boot-time daemon
   * decision) would otherwise be answered CLOSED forever, because boot runs
   * before any account is known and nothing later tells it the verdict arrived.
   * Deliberately carries no payload: a listener re-reads through `isEnabled`,
   * so there is no second copy of the verdict to drift from this one.
   */
  subscribe(listener: () => void): () => void;
};

const UNRESOLVED: DesktopMainFeatureFlagAssignment = {
  subject: null,
  flags: Object.freeze({}),
  delivery: FeatureAssignmentDelivery.Pending,
};

/**
 * Build a store. `fetchAssignment` is injected rather than imported so the
 * composition root owns the token/origin resolution — and so a test can drive
 * the account lifecycle without a network.
 */
/**
 * ISS-8792 — how long to wait before re-asking after a transport failure.
 *
 * `resolveFor` runs only on an account BOUNDARY, so without a retry a single
 * failed request settles this process CLOSED until the account changes — while
 * the renderer, which fetches the assignment separately, may well have
 * succeeded. That is the two-processes-disagree defect returning through the
 * failure path rather than through a second source. Bounded and short: this is
 * a fail-closed read, so giving up is safe, and an unbounded retry would keep a
 * signed-out or offline launch talking to the network forever.
 */
const RETRY_DELAYS_MS: readonly number[] = [250, 1000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type AssignmentFetchOutcome = {
  /** What the succeeding attempt returned; `null` when every attempt failed. */
  readonly payload: unknown;
  /** True when no attempt produced a payload. */
  readonly failed: boolean;
};

/** One attempt, with a rejection folded into the same absent-payload sentinel. */
async function attemptFetchAssignment(
  fetchAssignment: () => Promise<unknown>
): Promise<unknown> {
  try {
    return await fetchAssignment();
  } catch {
    return null;
  }
}

/**
 * One assignment read plus its bounded retry.
 *
 * Split out of `resolveFor` so the account/generation bookkeeping stays in one
 * place at the call site and this owns the retry and nothing else.
 *
 * THE ABSENT PAYLOAD IS THE FAILURE THIS LOOP HAS TO SURVIVE.
 * `fetchDesktopFeatureFlags` never rejects: every transport, timeout, response,
 * and schema failure resolves as `null`. Treating that sentinel as a successful
 * attempt retried nothing in the shipped app — only an injected rejection ever
 * reached a second attempt — so a single failed request settled main CLOSED
 * until the next account boundary, while the renderer, which fetches
 * separately, could resolve open. That is the two-processes-disagree defect
 * returning by the failure path.
 *
 * Resolves `null` when a newer account lookup superseded this one while it was
 * waiting between attempts; the caller must then settle nothing.
 */
async function readAssignmentWithRetry(options: {
  fetchAssignment: () => Promise<unknown>;
  retryDelaysMs: readonly number[];
  isSuperseded: () => boolean;
}): Promise<AssignmentFetchOutcome | null> {
  for (let attempt = 0; attempt <= options.retryDelaysMs.length; attempt += 1) {
    if (attempt > 0) {
      await delay(options.retryDelaysMs[attempt - 1] ?? 0);
      if (options.isSuperseded()) {
        return null;
      }
    }
    const payload = await attemptFetchAssignment(options.fetchAssignment);
    if (payload !== null && payload !== undefined) {
      return { payload, failed: false };
    }
  }
  return { payload: null, failed: true };
}

export function createDesktopMainFeatureFlagAssignmentStore(deps: {
  fetchAssignment: () => Promise<unknown>;
  /** Overridable so a suite drives the retry path without real time passing. */
  retryDelaysMs?: readonly number[];
}): DesktopMainFeatureFlagAssignmentStore {
  const retryDelaysMs = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  let assignment: DesktopMainFeatureFlagAssignment = UNRESOLVED;
  // Monotonic, so an out-of-order reply from a previous account can never
  // overwrite a newer one. The subject check alone is not enough: signing back
  // into the SAME account while its first lookup is still in flight would pass
  // it.
  let generation = 0;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      // One listener throwing must not strand the others, nor reject the
      // fire-and-forget `resolveFor` its caller never awaits.
      try {
        listener();
      } catch {
        // Intentionally ignored: a consumer's own failure is not the store's.
      }
    }
  };

  const settle = (at: number, next: DesktopMainFeatureFlagAssignment): void => {
    if (at !== generation) {
      return;
    }
    assignment = next;
    notify();
  };

  return {
    async resolveFor(subject) {
      generation += 1;
      const at = generation;
      assignment = { ...UNRESOLVED, subject };
      // The CLEAR is a verdict change too, so consumers hear about it now
      // rather than when the next account's reply lands. A main-process gate
      // that acts on a verdict would otherwise keep
      // running for the whole of the new account's lookup — up to the request
      // timeout plus its retries — while the renderer, which rejects the old
      // subject during render, has already withdrawn the surface. That gap is
      // the two-processes-disagree defect in miniature.
      notify();
      if (!subject) {
        settle(at, {
          subject: null,
          flags: UNRESOLVED.flags,
          delivery: FeatureAssignmentDelivery.Unavailable,
        });
        return;
      }
      const outcome = await readAssignmentWithRetry({
        fetchAssignment: deps.fetchAssignment,
        retryDelaysMs,
        isSuperseded: () => at !== generation,
      });
      if (!outcome) {
        return;
      }
      if (outcome.failed) {
        settle(at, {
          subject,
          flags: UNRESOLVED.flags,
          delivery: FeatureAssignmentDelivery.EvaluationFailed,
        });
        return;
      }
      // The SAME boundary read the renderer performs, so main and the renderer
      // classify a malformed payload, a reply for another account, and an
      // unevaluated assignment identically. A second classifier here is exactly
      // how the two processes would come to disagree about one account.
      const { delivery, flags, organizationEvaluated } = readFeatureAssignment(
        outcome.payload,
        subject
      );
      settle(at, {
        subject,
        flags,
        delivery,
        ...(organizationEvaluated ? { organizationEvaluated } : {}),
      });
    },
    isEnabled(key) {
      return assignment.flags[key] === true;
    },
    read() {
      return assignment;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The process-wide store, published by the composition root
 * (`desktop-services.ts`) once it can resolve a token and an origin.
 *
 * A module-level holder because main's flag consumers are plain functions deep
 * in a read path (`buildBranchListResult`) with no service container threaded to
 * them, and threading one purely to carry a flag would be the boolean-threading
 * defect wearing a different hat. Unset reads CLOSED, so a consumer that runs
 * before the wiring — or in a suite that never wires it — gets today's behavior.
 */
let publishedStore: DesktopMainFeatureFlagAssignmentStore | null = null;

export function publishDesktopMainFeatureFlagAssignmentStore(
  store: DesktopMainFeatureFlagAssignmentStore | null
): void {
  publishedStore = store;
}

/**
 * Whether a key is ON for the signed-in account. Unresolved is OFF.
 *
 * ISS-12048: a Dev Tools override wins over the assignment, but only when
 * main's own Dev Mode check passes for the signed-in account; see
 * `desktop-feature-flag-dev-mode.ts`.
 */
export function isDesktopMainFeatureFlagEnabled(key: string): boolean {
  const override = resolveDesktopMainDevModeOverride(key);
  if (override !== undefined) {
    return override;
  }
  return publishedStore?.isEnabled(key) === true;
}

/**
 * ISS-11425 — the published assignment ITSELF, or `null` when nothing is wired.
 *
 * {@link isDesktopMainFeatureFlagEnabled} folds every non-answer into `false`,
 * which is the right posture for a gate and the wrong one for a consumer that
 * must distinguish "evaluated, and you are not enrolled" from "no answer yet".
 * Session Mesh suppresses its cloud probe entirely on the first and must keep
 * probing on the second, so it reads the `delivery` here rather than inferring
 * one from a `false`.
 */
export function readDesktopMainFeatureFlagAssignment(): DesktopMainFeatureFlagAssignment | null {
  return publishedStore?.read() ?? null;
}

/**
 * ISS-8792 — subscribe to verdict changes on the published store.
 *
 * Returns a no-op unsubscribe when nothing is published yet (a suite that never
 * wires the composition root), matching {@link isDesktopMainFeatureFlagEnabled}'s
 * unset-reads-CLOSED posture rather than throwing.
 */
export function subscribeToDesktopMainFeatureFlagAssignment(
  listener: () => void
): () => void {
  const unsubscribeAssignment =
    publishedStore?.subscribe(listener) ?? (() => undefined);
  // ISS-12048: an override change is a verdict change for every gate that
  // reads through `isDesktopMainFeatureFlagEnabled`.
  const unsubscribeDevMode = subscribeToDesktopMainDevModeVerdicts(listener);
  return () => {
    unsubscribeAssignment();
    unsubscribeDevMode();
  };
}
