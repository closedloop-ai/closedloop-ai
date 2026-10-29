import { createContext } from "react";
import { DesktopAuthStatus } from "../../shared/contracts";

/**
 * Which app-core stack the desktop renderer runs (PLN-1138 D-E).
 *
 * The two modes are never unioned: a surface reads the local SQLite source or
 * the org-scoped cloud API, never both merged.
 *
 * Consumed by `DesktopAppCoreProvider`: the mode selects the per-mode
 * QueryClient, the Sessions read source (cloud → the shared HTTP source over the
 * D-G bridge; local → the SQLite source over IPC) and the Branches source,
 * swapping them together on a sign-in, sign-out or connectivity change. The
 * `scope`-keyed cache keeps the two sets isolated.
 */
export const DesktopAppCoreMode = {
  /** Signed out, mid-sign-in, or offline. */
  Local: "local",
  /** Authenticated and online: read the cloud API. */
  Cloud: "cloud",
} as const;

export type DesktopAppCoreMode =
  (typeof DesktopAppCoreMode)[keyof typeof DesktopAppCoreMode];

/**
 * Why a surface is reading this machine rather than the workspace (ISS-6972).
 *
 * Two reasons, because the predicate has exactly two ways to fail — a reason a
 * user can act on, derived from the same expression that picks the stack, so the
 * badge and the source can never describe different situations.
 *
 * `sync_off` was a third and is gone with the consent term it reported on: sync
 * consent governs what LEAVES this Mac, and a reader who sends nothing still
 * belongs in their workspace. See {@link resolveDesktopAppCoreMode}.
 */
export const DesktopLocalReadReason = {
  SignedOut: "signed_out",
  Offline: "offline",
} as const;

export type DesktopLocalReadReason =
  (typeof DesktopLocalReadReason)[keyof typeof DesktopLocalReadReason];

/**
 * The read-source badge's leading sentence per reason.
 *
 * Deliberately terse: the badge renders this ABOVE its standing "Showing the
 * data stored on this device" line, so a reason that restated the store would
 * say the same thing twice. Both remaining reasons say their own consequence.
 */
export const DESKTOP_LOCAL_READ_REASON_COPY: Record<
  DesktopLocalReadReason,
  string
> = {
  [DesktopLocalReadReason.SignedOut]: "You're signed out.",
  [DesktopLocalReadReason.Offline]: "You're offline.",
};

export type DesktopAppCoreModeInput = {
  /** Live main-process auth status, mirrored by `DesktopAuthProvider`. */
  status: DesktopAuthStatus;
  /**
   * Renderer connectivity, from `navigator.onLine`. Coarse by construction: it
   * reports whether the machine has a network interface, not whether the cloud
   * API is reachable. A cloud read that fails despite `isOnline` still surfaces
   * as a normal `ApiError` — this signal picks the stack, it does not promise
   * the request will succeed.
   */
  isOnline: boolean;
};

/**
 * The single rule for which stack is active (ISS-6972).
 *
 * Authenticated **and** online. Everything else is local. There is no backlog gate, no readiness fingerprint, no hysteresis latch
 * and no bounded fail-open: ISS-5477's machinery could not tell a machine that
 * had caught up from one whose lanes were never allowed to open, and its
 * five-minute fail-open then put the reader on a cloud that had never received a
 * row — the exact "signing in makes my data disappear" symptom it existed to
 * prevent.
 *
 * Only a durable session reaches the cloud: every transient sign-in status
 * (`opening_browser`, `awaiting_redirect`, `exchanging`) and every signed-out one
 * stays local, so the stack never flips mid-handshake. That mirrors the token
 * rule in `DesktopAuthProvider`, which surfaces a token only when
 * `authenticated`.
 *
 * SYNC CONSENT IS NOT A TERM HERE, and removing it is the point rather than a
 * simplification (operator ruling, 2026-09-25). Consent governs EGRESS — what
 * leaves this Mac — and it was deciding INGRESS too, which conflated two
 * different questions: "may we upload your sessions" and "may you read your
 * workspace". A signed-in reader who uploads nothing is still a member of an org
 * whose other machines, PRs and merged work are there to be read, so holding
 * them local answered the second question with the first. What it cost was
 * visible as missing cards: PRs shipped and merged LOC/$ are delivery metrics
 * with no local operand, so the strip dropped them for anyone who had not
 * elected a level yet — which, during onboarding, is everyone.
 *
 * The egress gate is untouched and is NOT this expression: it lives in main
 * (`agent-sync/sync-egress-gate.ts`) and drains on `consentTierForOrg` /
 * `syncTierAllowsSessionMetadata` directly. Nothing here can widen it.
 *
 * THE COST, stated because it is real: a SOLO reader who has answered Off now
 * reads a workspace they never filled, where before they read their own machine.
 * That is the "signing in makes my data disappear" shape the paragraph above
 * exists to warn about — narrowed to a reader whose org genuinely has nothing,
 * rather than every reader who had not answered a question yet.
 */
export function resolveDesktopAppCoreMode(
  input: DesktopAppCoreModeInput
): DesktopAppCoreMode {
  const readsCloud =
    input.status === DesktopAuthStatus.Authenticated && input.isOnline;
  return readsCloud ? DesktopAppCoreMode.Cloud : DesktopAppCoreMode.Local;
}

/**
 * Which of the two conditions is holding this reader on local data, or
 * `undefined` when it is reading the cloud.
 *
 * Total over the decision above — the mode has exactly these two ways to be
 * Local — so this can no longer return `undefined` for a Local reader, and a
 * badge is never left saying "showing this device" with no reason beside it.
 */
export function resolveDesktopLocalReadReason(
  input: DesktopAppCoreModeInput
): DesktopLocalReadReason | undefined {
  if (resolveDesktopAppCoreMode(input) === DesktopAppCoreMode.Cloud) {
    return undefined;
  }
  if (input.status !== DesktopAuthStatus.Authenticated) {
    return DesktopLocalReadReason.SignedOut;
  }
  return DesktopLocalReadReason.Offline;
}

/**
 * The active mode, provided by `DesktopAppCoreProvider` and read through its
 * `useDesktopAppCoreMode`. `Local` when no provider is mounted. Declared here,
 * not in the provider, so the dead-end reporter can read it without importing
 * the provider's module graph (ISS-12039).
 */
export const DesktopAppCoreModeContext = createContext<DesktopAppCoreMode>(
  DesktopAppCoreMode.Local
);
