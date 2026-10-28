import { PersistedPersonInfoKey } from "./posthog-persistence-repair";

/**
 * ISS-12559: resume the visitor's most recently active PostHog session when the
 * browser crosses between `closedloop.ai` subdomains.
 *
 * Marketing (`www.`/`marketing.closedloop.ai`) and the web app
 * (`app.closedloop.ai`) share one PostHog project, and posthog-js writes its
 * cookie-persisted keys to a `domain=.closedloop.ai` cookie both hosts can read.
 * Two things in posthog-js 1.359.1 (the copy `@posthog/next@0.1.0` pins and
 * initializes) keep that shared cookie from carrying the session across:
 *
 * - `createLocalPlusCookieStore._parse` (`src/storage.ts`) loads
 *   `extend(cookieProperties, localStorageRecord)`, so THIS origin's own
 *   localStorage `$sesid` beats the shared cookie's. A stale per-origin record
 *   from an earlier visit is idle past 30 minutes, and `SessionIdManager`
 *   rotates it on the first event: a new `$session_id` on every cross-site hop.
 * - On `app.closedloop.ai`, `@posthog/next`'s `postHogMiddleware` seeds a
 *   HOST-ONLY cookie of the same name on a first request that carried none.
 *   posthog-js never rewrites it (it writes the domain cookie), and
 *   `cookieStore._get` returns the first match in `document.cookie`, which for
 *   two `path=/` cookies is the older one (RFC 6265 §5.4) — the frozen seed.
 *
 * The fix is applied to the per-origin localStorage record BEFORE `posthog.init`
 * reads it: among this origin's own `$sesid` and every same-name cookie's, the
 * tuple with the latest activity wins. posthog-js writes the cookie on every
 * persistence save, so the shared cookie is never older than any origin's
 * localStorage unless that write failed; the activity comparison keeps the local
 * value in that case. Only the session key moves. Identity keys (`distinct_id`,
 * `$device_id`, `$user_state`) are left exactly as posthog-js loads them, so
 * `identify` and `reset` behave as they did.
 *
 * Not `bootstrap.sessionID`: posthog-js's public option is read from the init
 * config, which `@posthog/next`'s server `PostHogProvider` serializes from a
 * Server Component that cannot see this browser's cookies or localStorage, and
 * `SessionIdManager` stamps a bootstrapped session's activity as "now", which
 * would revive an idle session instead of letting posthog-js expire it.
 */

/** posthog-js `SESSION_ID`: `[lastActivityTimestamp, sessionId, sessionStartTimestamp]`. */
export const POSTHOG_SESSION_KEY = "$sesid";

/**
 * posthog-js `DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS`; neither site configures
 * `session_idle_timeout_seconds`.
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** posthog-js's consent record, stored as a cookie under `@posthog/next`'s defaults. */
const CONSENT_KEY_PREFIX = "__ph_opt_in_out_";

const PLUS_PATTERN = /\+/g;
const SLASH_PATTERN = /\//g;
const EQUALS_PATTERN = /=/g;

/** posthog-js `isNoLike`, as the stored (string) forms reach this module. */
const OPTED_OUT_VALUES: ReadonlySet<string> = new Set(["0", "false", "no"]);

export type StoredSession = readonly [
  lastActivityTimestamp: number,
  sessionId: string,
  sessionStartTimestamp: number,
];

export const SharedSessionResumeOutcome = {
  /** Consent was denied; posthog-js persists nothing, so neither does this. */
  OptedOut: "opted_out",
  /** No readable session in any shared cookie. */
  NoCookieSession: "no_cookie_session",
  /** posthog-js would already load the most recently active session. */
  AlreadyCurrent: "already_current",
  /** The local record is unreadable; posthog-js's own load handles it. */
  UnreadableLocalRecord: "unreadable_local_record",
  /**
   * The local `$sesid` is not a resumable tuple and no cookie session is still
   * active; it is left as posthog-js stored it.
   */
  LocalSessionNotComparable: "local_session_not_comparable",
  /** The local record now carries the most recently active session. */
  Resumed: "resumed",
} as const;
export type SharedSessionResumeOutcome =
  (typeof SharedSessionResumeOutcome)[keyof typeof SharedSessionResumeOutcome];

export type SharedSessionStorage = Pick<Storage, "getItem" | "setItem">;

/** posthog-js `parseName` for a config with no `persistence_name`. */
export function postHogPersistenceName(token: string): string {
  const sanitized = token
    .replace(PLUS_PATTERN, "PL")
    .replace(SLASH_PATTERN, "SL")
    .replace(EQUALS_PATTERN, "EQ");
  return `ph_${sanitized}_posthog`;
}

/**
 * Rewrites the per-origin record so posthog-js's load resumes the most recently
 * active session. Must run before `posthog.init`: the persistence constructor
 * saves what it loaded, which overwrites the shared cookie with the stale value.
 */
export function resumeSharedSession({
  token,
  cookieHeader,
  storage,
  now = Date.now(),
}: {
  token: string;
  cookieHeader: string;
  storage: SharedSessionStorage;
  now?: number;
}): SharedSessionResumeOutcome {
  const name = postHogPersistenceName(token);
  if (isOptedOut(token, cookieHeader, storage)) {
    return SharedSessionResumeOutcome.OptedOut;
  }
  const cookieValues = readCookieValues(cookieHeader, name);
  const cookieSessions = cookieValues.map((value) =>
    value === null ? undefined : sessionOf(parseJson(value))
  );
  const latest = latestSession(cookieSessions);
  if (!latest) {
    return SharedSessionResumeOutcome.NoCookieSession;
  }
  const rawLocal = storage.getItem(name);
  const localRecord = rawLocal === null ? {} : parseJson(rawLocal);
  if (!isRecord(localRecord)) {
    return SharedSessionResumeOutcome.UnreadableLocalRecord;
  }
  if (POSTHOG_SESSION_KEY in localRecord) {
    const local = sessionOf(localRecord);
    if (!local) {
      return resumeOverClearedSession(
        storage,
        name,
        localRecord,
        cookieSessions,
        now
      );
    }
    if (!isMoreRecent(latest, local)) {
      return SharedSessionResumeOutcome.AlreadyCurrent;
    }
  } else {
    // posthog-js's `cookieStore._get` loads the FIRST match only.
    const loaded = cookieSessions[0];
    if (loaded && !isMoreRecent(latest, loaded)) {
      return SharedSessionResumeOutcome.AlreadyCurrent;
    }
  }
  storage.setItem(name, JSON.stringify(withSession(localRecord, latest)));
  return SharedSessionResumeOutcome.Resumed;
}

/**
 * `[null, null, null]` is what `SessionIdManager.resetSessionId` writes: on
 * `reset()` at sign-out, and from `_resetIdleTimer` about 33 minutes after the
 * last activity in a background tab. It means "no local session", so the latest
 * cookie session wins. Sign-out cannot be undone by that: `reset()` also clears
 * both cookies and saves the cleared tuple to the domain cookie. A cookie
 * session that is already idle is not adopted — posthog-js would start a new
 * one anyway, and that is the only shape a stale host-only seed can have. Any
 * other unresumable tuple is posthog-js's to interpret.
 */
function resumeOverClearedSession(
  storage: SharedSessionStorage,
  name: string,
  localRecord: Record<string, unknown>,
  cookieSessions: readonly (StoredSession | undefined)[],
  now: number
): SharedSessionResumeOutcome {
  if (!isClearedSession(localRecord[POSTHOG_SESSION_KEY])) {
    return SharedSessionResumeOutcome.LocalSessionNotComparable;
  }
  const active = latestSession(
    cookieSessions.filter(
      (session) => session && now - session[0] <= SESSION_IDLE_TIMEOUT_MS
    )
  );
  if (!active) {
    return SharedSessionResumeOutcome.LocalSessionNotComparable;
  }
  storage.setItem(name, JSON.stringify(withSession(localRecord, active)));
  return SharedSessionResumeOutcome.Resumed;
}

function isClearedSession(stored: unknown): boolean {
  return (
    Array.isArray(stored) &&
    stored.length > 0 &&
    stored.every((part) => part === null)
  );
}

/**
 * `$client_session_props` holds the entry URL and referrer of the session it
 * names, and posthog-js rewrites it only from `SessionIdManager`'s change
 * callback. A record naming another session would stamp that session's entry
 * URL on this one's events, so it is removed. What replaces it depends on the
 * tab: when this origin has no window id in the tab's sessionStorage (its first
 * page load in the tab), posthog-js mints one, fires the callback, and records
 * THIS page as the entry; when the tab already holds one for this origin, the
 * callback does not fire and the resumed session carries no `$session_entry_*`
 * here. Either way, one merged session can carry different `$session_entry_*`
 * values on each site. A record of any other shape is left to `PostHogPersistenceGuard`, which
 * repairs and reports it.
 */
function withSession(
  record: Record<string, unknown>,
  session: StoredSession
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...record,
    [POSTHOG_SESSION_KEY]: [...session],
  };
  const sessionProps = next[PersistedPersonInfoKey.ClientSessionProps];
  if (isRecord(sessionProps) && sessionProps.sessionId !== session[1]) {
    delete next[PersistedPersonInfoKey.ClientSessionProps];
  }
  return next;
}

function isMoreRecent(candidate: StoredSession, current: StoredSession) {
  return candidate[0] > current[0];
}

function latestSession(
  sessions: readonly (StoredSession | undefined)[]
): StoredSession | undefined {
  let latest: StoredSession | undefined;
  for (const session of sessions) {
    if (session && (!latest || isMoreRecent(session, latest))) {
      latest = session;
    }
  }
  return latest;
}

/**
 * A tuple posthog-js itself would resume, or nothing. A two-element tuple is
 * completed with its activity time as the start, as `SessionIdManager` does.
 * Anything else is not adopted, and posthog-js's own handling of it is left in
 * place rather than replaced by a guess.
 */
function sessionOf(record: unknown): StoredSession | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  const stored = record[POSTHOG_SESSION_KEY];
  if (!Array.isArray(stored) || stored.length < 2) {
    return undefined;
  }
  const [lastActivity, sessionId, start = lastActivity] = stored;
  if (
    !isTimestamp(lastActivity) ||
    typeof sessionId !== "string" ||
    sessionId === "" ||
    !isTimestamp(start)
  ) {
    return undefined;
  }
  return [lastActivity, sessionId, start];
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * posthog-js `ConsentManager` with `opt_out_capturing_persistence_type:
 * 'cookie'`: the cookie decides, and a localStorage value is consulted (and
 * migrated) only when the cookie lookup has none.
 */
function isOptedOut(
  token: string,
  cookieHeader: string,
  storage: SharedSessionStorage
): boolean {
  const consentKey = `${CONSENT_KEY_PREFIX}${token}`;
  const stored =
    readCookieValues(cookieHeader, consentKey)[0] ??
    storage.getItem(consentKey);
  return (
    stored !== null && stored !== undefined && OPTED_OUT_VALUES.has(stored)
  );
}

/**
 * Every value stored under `name`, in browser order — a host-only and a domain
 * cookie can coexist. A value that does not URI-decode is `null`: posthog-js's
 * `cookieStore._get` returns null for the whole lookup when its match fails to
 * decode, so it never contributes a value.
 */
function readCookieValues(
  cookieHeader: string,
  name: string
): (string | null)[] {
  const prefix = `${name}=`;
  const values: (string | null)[] = [];
  for (const pair of cookieHeader.split(";")) {
    const trimmed = pair.replace(LEADING_SPACES, "");
    if (trimmed.startsWith(prefix)) {
      values.push(decodeOrNull(trimmed.slice(prefix.length)));
    }
  }
  return values;
}

const LEADING_SPACES = /^ +/;

function decodeOrNull(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
