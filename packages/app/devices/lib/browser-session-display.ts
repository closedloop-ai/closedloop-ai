import type { BrowserSessionActivity } from "@repo/api/src/types/browser-session";

/**
 * Display shaping for the browser sign-in rows ISS-9085 delivers (PLN-1915
 * Step 2).
 *
 * That contract passes the provider's values through raw and deliberately:
 * `deviceType` is a UA platform token (`Macintosh`, `X11`), `browserVersion` is
 * full (`148.0.7778.96`) where the design shows a major only, and city and
 * country are each independently optional. Shaping them is this module's whole
 * job, and it is pure so the rules are testable without a panel.
 *
 * The rule that outranks tidiness: absent input yields an explicit unknown
 * label, never a plausible default. A blank where a city should be, beside a
 * real country, reads as a fact about the device.
 */

export const BROWSER_SESSION_UNKNOWN_BROWSER_LABEL = "Unknown browser";
export const BROWSER_SESSION_UNKNOWN_DEVICE_LABEL = "Unknown device";
export const BROWSER_SESSION_UNKNOWN_LOCATION_LABEL = "Unknown location";
export const BROWSER_SESSION_MOBILE_DEVICE_LABEL = "Mobile device";

/** Leading numeric component of a dotted version string. */
const MAJOR_VERSION_PATTERN = /^(\d+)(?:\.|$)/;

/**
 * UA platform tokens mapped to what a person calls the machine.
 *
 * A `Map`, not an object literal: the key is untrusted provider input, and a
 * plain-object lookup on `__proto__` or `constructor` would answer with
 * something that is not a label.
 */
const DEVICE_PLATFORM_LABELS = new Map<string, string>([
  ["Macintosh", "Mac"],
  ["Windows", "Windows"],
  ["X11", "Linux"],
  ["Linux", "Linux"],
  ["CrOS", "Chromebook"],
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
]);

export type BrowserSessionDisplay = {
  browserLabel: string;
  deviceLabel: string;
  locationLabel: string;
};

/** The major component of a full version string, or null when unreadable. */
export function formatBrowserVersionMajor(
  browserVersion: string | undefined
): string | null {
  const match = MAJOR_VERSION_PATTERN.exec(trimmedOrEmpty(browserVersion));
  return match ? match[1] : null;
}

/** `"Chrome 148"`, `"Chrome"`, or the unknown label — never a bare version. */
export function formatBrowserLabel(
  activity: BrowserSessionActivity | null
): string {
  const name = trimmedOrEmpty(activity?.browserName);
  if (!name) {
    return BROWSER_SESSION_UNKNOWN_BROWSER_LABEL;
  }
  const major = formatBrowserVersionMajor(activity?.browserVersion);
  return major ? `${name} ${major}` : name;
}

/**
 * The device a session is signed in from.
 *
 * An unmapped-but-present platform token is echoed rather than replaced: it is
 * what the provider actually reported, and inventing a class for it would be
 * the plausible default this module exists to refuse. `isMobile` only decides
 * the case where no platform was reported at all.
 */
export function formatDeviceLabel(
  activity: BrowserSessionActivity | null
): string {
  const platform = trimmedOrEmpty(activity?.deviceType);
  if (platform) {
    return DEVICE_PLATFORM_LABELS.get(platform) ?? platform;
  }
  return activity?.isMobile === true
    ? BROWSER_SESSION_MOBILE_DEVICE_LABEL
    : BROWSER_SESSION_UNKNOWN_DEVICE_LABEL;
}

/**
 * `"Berlin, Germany"`, `"Berlin"`, `"Germany"`, or the unknown label. City and
 * country are independently optional, so each combination is its own answer.
 */
export function formatLocationLabel(
  activity: BrowserSessionActivity | null
): string {
  const city = trimmedOrEmpty(activity?.city);
  const country = trimmedOrEmpty(activity?.country);
  if (city && country) {
    return `${city}, ${country}`;
  }
  return city || country || BROWSER_SESSION_UNKNOWN_LOCATION_LABEL;
}

/** All three shaped labels for one session's activity. */
export function describeBrowserSession(
  activity: BrowserSessionActivity | null
): BrowserSessionDisplay {
  return {
    browserLabel: formatBrowserLabel(activity),
    deviceLabel: formatDeviceLabel(activity),
    locationLabel: formatLocationLabel(activity),
  };
}

/**
 * How much of the user's session set a returned page accounts for.
 *
 * Three members rather than a boolean, because "this page is everything" and
 * "we could not tell" are different answers and a consumer has to be able to
 * say the second one out loud. Collapsed to a boolean, an unreconcilable total
 * renders as a complete page — exactly the plausible default this module
 * refuses everywhere else.
 */
export const BrowserSessionPageCompleteness = {
  /** The rows in hand are the user's whole active set. */
  Complete: "complete",
  /** The provider holds more sessions than this page returned. */
  Truncated: "truncated",
  /** The provider's total could not be reconciled, so neither claim is made. */
  Unknown: "unknown",
} as const;

export type BrowserSessionPageCompleteness =
  (typeof BrowserSessionPageCompleteness)[keyof typeof BrowserSessionPageCompleteness];

export type BrowserSessionPageCoverage = {
  shownCount: number;
  /**
   * Null when the provider's total cannot be reconciled with this page. Always
   * paired with `completeness: Unknown` — the two never disagree.
   */
  totalCount: number | null;
  completeness: BrowserSessionPageCompleteness;
};

/**
 * Whether a returned page is the whole set.
 *
 * `totalCount` is the provider's count of ALL the user's active sessions, so a
 * bounded page that says nothing about it reads as complete. A total that
 * cannot be reconciled with the page in hand is reported as absent rather than
 * rendered, because a wrong total is worse than no total — and the page is then
 * `Unknown`, never `Complete`.
 *
 * Reconcilable means a SAFE integer no smaller than the rows returned. Past
 * `Number.MAX_SAFE_INTEGER` a count has already lost precision on the way here,
 * so `Number.isInteger` still answers true for a value that is no longer the
 * number the provider sent; presenting it would be a rounded total rendered as
 * an exact one. Fractional, non-finite, and negative totals fall out of the
 * same predicate.
 */
export function describeBrowserSessionPage(page: {
  sessions: readonly unknown[];
  totalCount: number;
}): BrowserSessionPageCoverage {
  const shownCount = page.sessions.length;
  const reconciles =
    Number.isSafeInteger(page.totalCount) && page.totalCount >= shownCount;
  if (!reconciles) {
    return {
      shownCount,
      totalCount: null,
      completeness: BrowserSessionPageCompleteness.Unknown,
    };
  }
  return {
    shownCount,
    totalCount: page.totalCount,
    completeness:
      page.totalCount > shownCount
        ? BrowserSessionPageCompleteness.Truncated
        : BrowserSessionPageCompleteness.Complete,
  };
}

function trimmedOrEmpty(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
