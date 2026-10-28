/**
 * The signed-in user's own Clerk browser sessions, as ISS-8366's Connected
 * Devices panel consumes them (ISS-9085).
 *
 * This module is the boundary: no `@clerk/backend` type crosses it, so a
 * bundle-sensitive web client and the Desktop renderer can both import the
 * shape without pulling the provider SDK.
 *
 * Distinct from the Desktop refresh-token families under
 * `apps/api/app/desktop/session/`. A browser session and a registered Desktop
 * have different authorities and different lifecycles; they are never merged
 * into one taxonomy.
 */

/**
 * Coded refusals, so a consumer can tell them apart without parsing prose.
 *
 * `SessionNotFound` deliberately covers BOTH a session that does not exist and
 * one owned by somebody else. Splitting them would let a caller confirm that a
 * guessed id is real, which is the enumeration this contract exists to refuse.
 */
export const BrowserSessionErrorCode = {
  /** The target is the caller's own session; the sign-out flow owns that. */
  CurrentSessionNotRevocable: "current_session_not_revocable",
  /** No such session, or not this caller's. Deliberately one code. */
  SessionNotFound: "session_not_found",
  /** The identity provider could not be reached or refused. Never an empty list. */
  ProviderUnavailable: "provider_unavailable",
} as const;

export type BrowserSessionErrorCode =
  (typeof BrowserSessionErrorCode)[keyof typeof BrowserSessionErrorCode];

/**
 * What the provider could substantiate about the device behind a session.
 *
 * Every field is optional and OMITTED when absent rather than serialized as
 * `null` — an already-installed Desktop build parses a missing key, and the
 * repo's cross-repo rule reserves `null` for contracts that declare it.
 *
 * The values are raw on purpose. `deviceType` is a UA-derived platform string
 * (`Macintosh`, `Windows`, `X11`), not a curated device class, and
 * `browserVersion` is full (`148.0.7778.96`) where the prototype shows a major
 * only. Shaping either for display belongs to the consumer, not here.
 *
 * No IP address. Clerk returns one; the approved panel shows city and country,
 * and widening that to a precise network address is a privacy expansion nobody
 * asked for.
 */
export type BrowserSessionActivity = {
  browserName?: string;
  browserVersion?: string;
  deviceType?: string;
  isMobile?: boolean;
  city?: string;
  country?: string;
};

export type BrowserSession = {
  id: string;
  /**
   * Whether this row is the session making the request. Only ever true on a
   * Clerk-session transport — read alongside `currentSessionKnown`, never
   * alone.
   *
   * Not `isCurrent`: in `apps/api` that name is the retired branch current-PR
   * pointer (ISS-8521), and its inventory guard counts any bare `isCurrent` as
   * a pointer read. The two concepts are unrelated, so this one carries the
   * longer name rather than collide with a term of art mid-migration.
   */
  isCurrentSession: boolean;
  /** ISO-8601. */
  lastActiveAt: string;
  /** ISO-8601. */
  expireAt: string;
  /**
   * `null` means the provider carried no activity object on this read, which is
   * NOT the same as an activity object whose fields were blank. The list read
   * is the only path that carries activity at all, so a null here is a genuine
   * provider silence rather than an artifact of which endpoint was called.
   */
  activity: BrowserSessionActivity | null;
};

export type BrowserSessionListResponse = {
  sessions: BrowserSession[];
  /**
   * Total active sessions for this user, not the length of `sessions`. Without
   * it a truncated first page reads as the complete set.
   */
  totalCount: number;
  limit: number;
  offset: number;
  /**
   * Whether the caller's transport HAS a current browser session to identify.
   *
   * False on the Desktop transport, whose token is a refresh-token-family id
   * rather than a Clerk session id. Without this flag a consumer cannot tell
   * "none of these rows is the one you are using" from "we cannot tell which
   * one you are using", and would offer to sign the user out of the session
   * they are actively holding.
   */
  currentSessionKnown: boolean;
};

export type BrowserSessionRevokeResponse = {
  revoked: true;
};

/**
 * Rows per page when the caller does not ask.
 *
 * Exported rather than private to the route because the client sends the bound
 * explicitly — its query key is keyed by it, and a page whose size the caller
 * never stated cannot be reconciled against `totalCount` afterwards. Applying
 * it is the route's job: `clampPageLimit` (`page-limit-bounds.ts`) is the one
 * clamp, so the two sides cannot round differently (ISS-8734).
 */
export const BROWSER_SESSION_PAGE_LIMIT_DEFAULT = 20;

/**
 * Hard ceiling on rows per page.
 *
 * Load-bearing rather than decorative: the provider answers an out-of-range
 * limit with HTTP 200 and its own 10-row default instead of an error, so an
 * unclamped bound returns a short page that reads as a complete answer. Kept
 * well inside the provider's own 500 maximum.
 */
export const BROWSER_SESSION_PAGE_LIMIT_MAX = 100;

/**
 * Hard ceiling on the page offset.
 *
 * At the maximum page size this reaches page 100, far past any population the
 * panel will show. Bounded because the provider rejects an absurd offset by
 * throwing, which the route can only report as a 503 — a caller mistake
 * rendered as a provider outage. Clamped, an over-range offset is an empty
 * page instead.
 */
export const BROWSER_SESSION_OFFSET_MAX = 10_000;
