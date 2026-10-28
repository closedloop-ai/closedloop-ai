import { ANONYMOUS_DESKTOP_FEATURE_FLAG_KEYS } from "@repo/api/src/types/desktop-feature-flags";
import { readFeatureAssignment } from "@repo/api/src/types/feature-assignment-boundary";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createDesktopAuthStore } from "../shared-agent-sessions/desktop-auth-provider";
import { useOnlineStatus } from "../shared-agent-sessions/use-online-status";

/**
 * ISS-8024 — the renderer's view of the signed-in user's PostHog assignment.
 *
 * `resolved` is SETTLED-ness, not enabled-ness: `false` means the answer has not
 * arrived and a one-way decision must wait, while `true` with an empty `flags`
 * is a real, final "this user has no gates open". Collapsing the two is what
 * makes a gate either flash open or hang in loading forever, so they stay
 * separate all the way to `useFeatureFlagResolved`.
 */
export type DesktopPostHogFlagAssignment = {
  flags: Readonly<Record<string, boolean>>;
  resolved: boolean;
  /**
   * WHY the assignment reads the way it does: `resolved` alone cannot say
   * whether a closed gate was evaluated closed or never reached us, and a caller
   * that withholds a one-way decision needs to tell those apart. Every terminal
   * delivery still reports `resolved: true`, so the ISS-8024 no-flash behaviour
   * is unchanged.
   */
  delivery: FeatureAssignmentDelivery;
  /**
   * WHO this verdict was evaluated for — `null` when there is no account yet.
   *
   * The subject travels WITH the answer, so a render can tell whether the
   * verdict it holds belongs to the account currently signed in without waiting
   * for an effect, rather than holding one account's non-answer over the next
   * account's evaluation.
   */
  subject: string | null;
};

/** Nothing known, nothing settled — the state a gated route waits on. */
const PENDING: DesktopPostHogFlagAssignment = {
  flags: {},
  resolved: false,
  delivery: FeatureAssignmentDelivery.Pending,
  subject: null,
};

/**
 * Settled with nothing open, tagged with WHY. Reached by every terminal
 * non-answer: signed out, offline, bridge absent, transport failure, an
 * assignment for a different user.
 *
 * Deliberately SETTLED rather than pending. Fail-closed (ISS-4779) is about the
 * VALUE, and the value here is closed either way; holding `resolved` false as
 * well would strand a gated route in its loading state with no event left that
 * could ever release it. `DesktopFeatureFlagProvider` makes the same call for an
 * unreachable flags bridge, for the same reason.
 */
function closedWith(
  delivery: FeatureAssignmentDelivery,
  subject: string | null
): DesktopPostHogFlagAssignment {
  return { flags: {}, resolved: true, delivery, subject };
}

/**
 * Resolve the signed-in user's PostHog flag assignment over the main-process
 * bridge (ISS-8024).
 *
 * Identity, correlation, and reset follow the `DesktopParsingBugFlagProvider`
 * precedent — the existing per-user, remotely-resolved, fail-closed desktop gate
 * — rather than a new design: the assignment is cleared the instant
 * `authedUserId` changes, a reply is adopted only when its own `userId` matches
 * the account it was requested for, and the lookup re-runs on the online
 * transition.
 *
 * FAIL-CLOSED IN EVERY BUILD, dev included. The Labs-backed adapter this
 * replaced resolved unknown shared flags from `app.isPackaged` — ENABLED
 * unpackaged — which is a dev-only fail-OPEN. Nothing here reads the build type:
 * an unresolvable flag is closed on a developer's machine exactly as it is in a
 * packaged release.
 *
 * UNCONDITIONAL since ISS-8753. This used to take an `enabled` gate so a build
 * with the cutover flag off paid no extra round trip; there is no second
 * resolution path left to fall back to, so the gate and every branch it guarded
 * are gone with it.
 */
export function useDesktopPostHogFlagAssignment(): DesktopPostHogFlagAssignment {
  const { isAuthLoading, authedUserId } = useAuthSubject();
  const isOnline = useOnlineStatus();
  const harnessSeed = useE2eHarnessSeed();
  const [assignment, setAssignment] =
    useState<DesktopPostHogFlagAssignment>(PENDING);

  useEffect(() => {
    // Clear any prior verdict up front so one account's gates cannot linger
    // while the next account's lookup is in flight.
    setAssignment({ ...PENDING, subject: authedUserId });

    // ISS-8753 — the Electron E2E seam, consulted BEFORE the auth path because
    // the harness launches with no account and that is a terminal CLOSED answer
    // for every key. `payload` is `null` on every shipped launch (main refuses a
    // packaged build outright and refuses an unpackaged one without the harness
    // launch argument), so this falls through to the real path below.
    //
    // Held PENDING until the seam has ANSWERED, not merely been asked: settling
    // closed first and overriding on arrival would publish a resolved-closed
    // frame that a one-way gate can act on, which is the same hazard the
    // `isAuthLoading` wait below exists for. It costs nothing in production —
    // both this and the auth store's own IPC pull are issued in the same commit,
    // and the wait below is longer.
    if (!harnessSeed.settled) {
      return;
    }
    if (harnessSeed.payload !== null) {
      // The SAME boundary read a real reply gets, over the same wire shape, with
      // the documented anonymous subject — which an unauthenticated harness
      // launch actually is. A malformed seed therefore classifies as malformed
      // rather than opening a gate.
      const { delivery, flags } = readFeatureAssignment(
        harnessSeed.payload,
        null
      );
      setAssignment({ flags, resolved: true, delivery, subject: authedUserId });
      return;
    }

    // The auth bridge has not answered yet. PENDING, not CLOSED: "we do not
    // know who this is" is not "nobody is signed in", and the store's own
    // initial snapshot is `loading` until its IPC pull resolves. Settling
    // CLOSED here published a resolved-closed frame on every signed-in launch,
    // which a one-way gate can act on before the real assignment is even
    // requested. The pull always settles into a terminal status below, so this
    // wait cannot strand a route.
    if (isAuthLoading) {
      return;
    }

    // Signed-out (once its anonymous read below settles), offline, and
    // bridge-absent are terminal for now, not pending:
    // signing in or coming back online re-runs this effect. They stay SEPARATE
    // deliveries because they close the same gates for different reasons, and
    // ISS-8372's root resolver reports which one locked the legacy tree.
    const close = (delivery: FeatureAssignmentDelivery) =>
      setAssignment(closedWith(delivery, authedUserId));
    if (!authedUserId) {
      if (!isOnline) {
        close(FeatureAssignmentDelivery.Unavailable);
        return;
      }
      return adoptAnonymousAssignment(close, setAssignment);
    }
    if (!isOnline) {
      close(FeatureAssignmentDelivery.Offline);
      return;
    }
    const fetchAssignment = window.desktopApi?.getDesktopFeatureFlags;
    if (!fetchAssignment) {
      close(FeatureAssignmentDelivery.MissingBridge);
      return;
    }

    let cancelled = false;
    fetchAssignment()
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setAssignment(readAssignmentFor(authedUserId, payload));
      })
      .catch(() => {
        if (!cancelled) {
          close(FeatureAssignmentDelivery.EvaluationFailed);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authedUserId, harnessSeed, isAuthLoading, isOnline]);

  // RENDER-TIME correlation, not just the effect's reset above. The effect runs
  // AFTER React commits, so on an account switch the render that first carries
  // the new `authedUserId` would otherwise commit while `assignment` still held
  // the PREVIOUS account's flags — one frame in which a gate can mount for the
  // wrong person. Whose answer this is travels WITH the answer, so a verdict
  // that does not belong to the current subject is never returned at all; the
  // effect's reset then refills it for the new account.
  return assignment.subject === authedUserId ? assignment : PENDING;
}

/**
 * The signed-in user id, read straight off the main-process auth bridge.
 *
 * NOT `useDesktopAuth`, and the reason is mounting, not tree order:
 * `DesktopAuthProvider` IS an ancestor in production (`main.tsx` →
 * `DesktopAppCoreProvider` → `DesktopAuthProvider` → `App` →
 * `DesktopFeatureFlagProvider`), but `useDesktopAuth` THROWS without that
 * ancestor, and `DesktopFeatureFlagProvider` is deliberately mounted standalone
 * — no auth provider above it — by its own suite, by
 * `settings-panel-labs-tab-gate.test.tsx`, and by this file's cases. Calling the
 * context hook here would turn every one of those mounts into a crash.
 *
 * So it subscribes to the same bridge through the same `createDesktopAuthStore`
 * factory instead of re-deriving the auth contract, which keeps the two from
 * disagreeing about what "authenticated" means. The cost is a second mirror of a
 * value the app already tracks, charged on every launch now that this is the
 * only resolution path there is.
 */
function useAuthSubject(): {
  isAuthLoading: boolean;
  authedUserId: string | null;
} {
  const storeRef = useRef<ReturnType<typeof createDesktopAuthStore> | null>(
    null
  );
  if (storeRef.current === null) {
    // Construction alone touches no IPC — the bridge is wired on first
    // subscribe — so building it eagerly costs nothing while disabled.
    storeRef.current = createDesktopAuthStore();
  }
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // `loading` is reported SEPARATELY rather than collapsed into a null user id.
  // Both mean "no user id right now", but only one of them is terminal, and the
  // caller settles CLOSED on the terminal one.
  return {
    isAuthLoading: state.status === "loading",
    authedUserId: state.status === "authenticated" ? state.userId : null,
  };
}

/**
 * Adopt an assignment only when it belongs to the account it was requested for
 * AND the server actually resolved it; anything else is closed.
 *
 * ISS-8372 routes the decision through the shared boundary read rather than
 * repeating it here, so the renderer classifies a malformed payload, a reply for
 * another account, and an unevaluated assignment the same way every other
 * consumer of this contract does. That matters most for MALFORMED: main parses
 * the API response, but a version-skewed main and renderer are two different
 * builds, and this is the process boundary between them.
 */
function readAssignmentFor(
  authedUserId: string,
  payload: unknown
): DesktopPostHogFlagAssignment {
  const { delivery, flags } = readFeatureAssignment(payload, authedUserId);
  return { flags, resolved: true, delivery, subject: authedUserId };
}

/**
 * ISS-8753 — whether this launch was handed a flag assignment by the Electron
 * E2E harness, and what it was.
 *
 * A TEST SEAM, NOT A PRODUCT PATH, and the gating that makes that true lives in
 * the main process rather than here: `readE2eFeatureFlagAssignment` returns
 * `null` for a packaged build before it reads argv at all, and `null` for an
 * unpackaged build that was not started with the harness launch argument, which
 * no shipped launcher passes. So a real user's local files open no gate through
 * this — reinstating that ability is precisely what the ISS-8753 cutover
 * removed. The renderer deliberately holds no gate of its own: a second one here
 * could only be `isPackaged`, which is a dev build and not a test harness.
 *
 * WHY IT EXISTS. Desktop flag resolution is the signed-in user's server-side
 * PostHog assignment, and the Electron E2E harness launches with no account —
 * a terminal CLOSED answer for every key. Forty-two specs, including the two
 * "(flag on)" cases the required `desktop` job runs in
 * `settings-labs-gateway-health.spec.ts`, need an assignment to read.
 *
 * `settled: false` is "not asked yet", distinct from `payload: null` = "asked,
 * no seed" — the same settled-vs-value separation the assignment itself keeps.
 * A missing bridge member (an older preload, or a renderer suite that
 * hand-writes `window.desktopApi`) and a rejected call both settle as NO SEED
 * rather than stranding the caller.
 */
function useE2eHarnessSeed(): E2eHarnessSeed {
  const [seed, setSeed] = useState<E2eHarnessSeed>(SEED_UNASKED);

  useEffect(() => {
    const readSeed = window.desktopApi?.getE2eSeededFeatureFlags;
    if (!readSeed) {
      setSeed(SEED_ABSENT);
      return;
    }
    let cancelled = false;
    readSeed()
      .then((payload) => {
        if (!cancelled) {
          setSeed(payload ? { settled: true, payload } : SEED_ABSENT);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSeed(SEED_ABSENT);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return seed;
}

type E2eHarnessSeed = {
  /** Has the seam ANSWERED? Never conflated with whether it had a seed. */
  settled: boolean;
  payload: unknown;
};

const SEED_UNASKED: E2eHarnessSeed = { settled: false, payload: null };
const SEED_ABSENT: E2eHarnessSeed = { settled: true, payload: null };

/**
 * ISS-11945 (ISS-11866 D4): a signed-out install's own `node_uuid`-keyed
 * assignment, read over the same bridge. While it is in flight the frame is
 * settled closed with delivery `Pending`, so no existing gate waits on it and a
 * consumer can still tell "closed, still asking" from "closed, final". Adopted
 * only when it answered, and only for the allow-listed keys: a reply main
 * produced for an account this renderer has not heard of yet cannot open any
 * other gate for a guest. Every non-answer settles closed `Unavailable`.
 */
function adoptAnonymousAssignment(
  close: (delivery: FeatureAssignmentDelivery) => void,
  setAssignment: (next: DesktopPostHogFlagAssignment) => void
): (() => void) | undefined {
  const fetchAssignment = window.desktopApi?.getDesktopFeatureFlags;
  if (!fetchAssignment) {
    close(FeatureAssignmentDelivery.Unavailable);
    return;
  }
  close(FeatureAssignmentDelivery.Pending);
  let cancelled = false;
  fetchAssignment()
    .then((payload) => {
      if (cancelled) {
        return;
      }
      const { delivery, flags } = readFeatureAssignment(payload, null);
      if (delivery !== FeatureAssignmentDelivery.Assigned) {
        close(FeatureAssignmentDelivery.Unavailable);
        return;
      }
      setAssignment({
        flags: Object.fromEntries(
          ANONYMOUS_DESKTOP_FEATURE_FLAG_KEYS.filter((key) =>
            Object.hasOwn(flags, key)
          ).map((key) => [key, flags[key] === true])
        ),
        resolved: true,
        delivery,
        subject: null,
      });
    })
    .catch(() => {
      if (!cancelled) {
        close(FeatureAssignmentDelivery.Unavailable);
      }
    });
  return () => {
    cancelled = true;
  };
}
