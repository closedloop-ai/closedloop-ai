/**
 * ISS-8024 — the signed-in desktop user's PostHog feature-flag assignment.
 *
 * Returned by `GET /desktop/feature-flags` and consumed by the desktop main
 * process, which forwards it to the renderer over the IPC bridge. Shared here
 * (per the "never define the same contract twice" rule) so the API route that
 * produces it and the desktop main process that consumes it agree on one shape.
 *
 * The evaluation happens SERVER-SIDE, on the same distinct ids and against the
 * same PostHog project the web app resolves from, so desktop and web cannot
 * disagree about a shared gate. The desktop renderer never talks to PostHog
 * itself: its `connect-src` admits only the replay proxy, and the packaged
 * renderer makes no outbound network requests at all (see
 * `apps/desktop/src/shared/content-security-policy.ts`).
 */
export type DesktopFeatureFlagAssignment = {
  /**
   * The user this assignment was evaluated FOR. The desktop correlates it
   * against the account it asked for, so a late reply for a previous user can
   * never grant that user's flags to the current one. In the unauthenticated
   * mode (ISS-11945) it is the install's `node_uuid`.
   */
  userId: string;
  /**
   * Whether the flag service actually ANSWERED. `false` means the assignment is
   * UNKNOWN — no analytics client is configured, or every evaluation failed —
   * and NOT "every flag is off". Both render closed; only a consumer that must
   * distinguish "not loaded yet" from "resolved false" (the no-flash gate) needs
   * the difference.
   */
  resolved: boolean;
  /**
   * The per-key verdict, exactly as web resolves it. Contains only keys the flag
   * service answered for; an ABSENT key is unknown and resolves CLOSED. Always
   * empty when {@link DesktopFeatureFlagAssignment.resolved} is `false`.
   */
  flags: Record<string, boolean>;
  /**
   * ISS-12552 (PRD-800 "Rollout"): the keys in `flags` the service
   * evaluated for the account's organization rather than for the person, today
   * only `attribution-evidence-policy`. Optional and additive: an API that
   * predates it, or has rolled back, omits it, and Desktop then reads that
   * key's value as no answer.
   */
  organizationEvaluated?: string[];
};

/** ISS-11945 (ISS-11866 D4): the PostHog key gating desktop session replay. */
export const DESKTOP_SESSION_REPLAY_FLAG_KEY =
  "desktop-session-replay" as const;

/**
 * ISS-11945 (ISS-11866 D4): the RENDERER's filter only — the keys the desktop
 * renderer adopts from a signed-out install's
 * `GET /desktop/feature-flags/anonymous` reply. The API never reads this list:
 * `desktopFeatureFlagsService.getAnonymous` evaluates the one key it names, so
 * a key added here stays closed until that service evaluates it too.
 */
export const ANONYMOUS_DESKTOP_FEATURE_FLAG_KEYS: readonly string[] = [
  DESKTOP_SESSION_REPLAY_FLAG_KEY,
];

/** ISS-11945: the unauthenticated, `node_uuid`-keyed flag read. */
export const DESKTOP_ANONYMOUS_FEATURE_FLAGS_PATH =
  "/desktop/feature-flags/anonymous";

/**
 * ISS-11945: carries a signed-out install's `node_uuid` (a v4 UUID) on
 * {@link DESKTOP_ANONYMOUS_FEATURE_FLAGS_PATH}. A header rather than a query
 * parameter, so the id stays out of request URLs and their logs.
 */
export const DESKTOP_FEATURE_FLAGS_NODE_UUID_HEADER = "x-desktop-node-uuid";
