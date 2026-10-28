/**
 * Pure parsers for the Pensero delivery feed (ISS-8399). No I/O, no secrets.
 *
 * Every function here is deliberately STRICT and returns `null` rather than a
 * best guess. The feed's strings are lossy in ways that punish optimism:
 * titles are not unique, have their markup stripped, contain nested quotes,
 * and carry `#`-prefixed tokens that are Slack channels rather than PR numbers.
 * A confident wrong answer here charges one pull request with another's points.
 */

import {
  PenseroDeliveryItemType,
  type PenseroDeliveryItemType as PenseroDeliveryItemTypeType,
  PenseroDeliveryRole,
  type PenseroDeliveryRole as PenseroDeliveryRoleType,
  PenseroInteractionKind,
  type PenseroInteractionRef,
  type PenseroPullRequestRef,
} from "./delivery-contract";

/**
 * `/interactions/<kind>/<id>` — the intra-feed join key. The creator row for a
 * pull request and every review row on it share this exact path, and it is the
 * ONLY way a creator row (which carries no PR number of its own) can be
 * associated with one.
 */
const INTERACTION_URL_RE = /^\/interactions\/([a-z_]+)\/(\d+)\/?$/;

/** `/ticketing/ticket/<id>` — Pensero's own ticket, not one of our artifacts. */
const TICKET_URL_RE = /^\/ticketing\/ticket\/(\d+)\/?$/;

/**
 * The ONLY sanctioned way to read a pull request out of a delivery title.
 *
 * Anchored on the literal `pull_request: ` prefix that Pensero's review-row
 * template emits, then `<owner>/<repo>#<digits>`, and it stops at the digits.
 * Three things this anchoring buys, each of which a looser pattern loses:
 *
 * - A `#team-ci-alerts` in a PR title is a Slack channel; there is no
 *   `pull_request: owner/repo` in front of it, so it cannot match.
 * - A `messaging` row's `closedloop-ai/closedloop-ai#4159:` reference is a
 *   Slack message ABOUT a PR, not delivery on it, and is likewise unanchored.
 * - Everything after the number (`with title '…'`) is discarded. Titles are not
 *   unique, are lossy, and embed unescaped single quotes — they are never a
 *   matching key, not even as a fallback.
 */
const REVIEW_PULL_REQUEST_RE =
  /pull_request:\s+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)/;

/** `YYYY-MM-DD`, the only date shape the feed emits. */
const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `<owner>/<repo>`, the stored normalized repository identity. */
const FULL_NAME_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

/**
 * POSITIVE evidence that an item type we do not recognize is a variant of the
 * review type — it must name both a pull request and a review, in that order.
 * `pull_request_review_v2` qualifies; `messaging_v2` does not.
 */
const REVIEW_CAPABLE_RAW_ITEM_TYPE_RE = /^pull_request.*review/i;

/**
 * Classify a wire `item_type`. An unrecognized value folds to
 * {@link PenseroDeliveryItemType.Other} rather than rejecting the row: the
 * provider owns this vocabulary, and a row we cannot classify still happened.
 */
export function classifyDeliveryItemType(
  rawItemType: string
): PenseroDeliveryItemTypeType {
  const known: readonly string[] = Object.values(PenseroDeliveryItemType);
  return known.includes(rawItemType) &&
    rawItemType !== PenseroDeliveryItemType.Other
    ? (rawItemType as PenseroDeliveryItemTypeType)
    : PenseroDeliveryItemType.Other;
}

/** Classify a wire `role`, folding an unrecognized value to `Other`. */
export function classifyDeliveryRole(rawRole: string): PenseroDeliveryRoleType {
  const known: readonly string[] = Object.values(PenseroDeliveryRole);
  return known.includes(rawRole) && rawRole !== PenseroDeliveryRole.Other
    ? (rawRole as PenseroDeliveryRoleType)
    : PenseroDeliveryRole.Other;
}

/**
 * Parse a delivery row's `url` into the interaction it names. Returns `null`
 * for a null url (messaging rows have none) and for any path shape this
 * contract does not recognize — an unrecognized path is not coerced into a
 * pull-request interaction.
 */
export function parseInteractionUrl(
  url: string | null | undefined
): PenseroInteractionRef | null {
  if (!url) {
    return null;
  }
  const interaction = INTERACTION_URL_RE.exec(url);
  if (interaction && interaction[1] === PenseroInteractionKind.PullRequest) {
    return { kind: PenseroInteractionKind.PullRequest, id: interaction[2] };
  }
  const ticket = TICKET_URL_RE.exec(url);
  if (ticket) {
    return { kind: PenseroInteractionKind.Ticket, id: ticket[1] };
  }
  return null;
}

/**
 * Read `<owner>/<repo>#<number>` out of a review row's title, or `null`.
 *
 * `owner`/`repo` are lowercased here because GitHub treats them
 * case-insensitively and every repository identity key in this repo is
 * normalized the same way; the number is parsed as an integer.
 */
export function parseReviewPullRequestRef(
  title: string
): PenseroPullRequestRef | null {
  const match = REVIEW_PULL_REQUEST_RE.exec(title);
  if (!match) {
    return null;
  }
  const number = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  return {
    owner: match[1].toLowerCase(),
    repo: match[2].toLowerCase(),
    number,
  };
}

/**
 * May a row carry the review template's `pull_request:` reference in its title?
 *
 * The reference is emitted by the REVIEW row template, so a `creator` row's
 * title is the pull request's own title and a `messaging` row's is a Slack
 * message — neither is a place that reference legitimately appears, and reading
 * one out of them would hand a row an identity it never established. Worse than
 * the row itself: that reference then enters the interaction index and gives
 * every sibling row on the interaction the same borrowed identity.
 *
 * An UNRECOGNIZED type needs POSITIVE evidence, not the benefit of the doubt.
 * `Other` is where every unknown spelling lands, not merely a renamed review —
 * `messaging_v2` folds there just as `pull_request_review_v2` does — so
 * admitting the whole bucket reopens exactly the hole this closes. The raw wire
 * type must itself name a pull-request review before its title is read.
 *
 * The failure mode of being wrong in this direction is the safe one: an
 * unclassified review variant yields no reference, its rows resolve as
 * PENDING_REFERENCE, and the run reports them as awaiting one. A missing
 * reference is visible; a borrowed one is not.
 */
export function mayCarryPullRequestReference(
  itemType: PenseroDeliveryItemTypeType,
  rawItemType: string
): boolean {
  if (itemType === PenseroDeliveryItemType.PullRequestReview) {
    return true;
  }
  if (itemType !== PenseroDeliveryItemType.Other) {
    return false;
  }
  return REVIEW_CAPABLE_RAW_ITEM_TYPE_RE.test(rawItemType.trim());
}

/** `owner/repo` for a parsed ref, in the repo's canonical normalized form. */
export function pullRequestRefFullName(ref: PenseroPullRequestRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * True when two refs name the same pull request. Used to detect an AMBIGUOUS
 * interaction — two review rows sharing one `url` but naming different PRs —
 * which must not resolve to "pick the first".
 */
export function samePullRequestRef(
  left: PenseroPullRequestRef,
  right: PenseroPullRequestRef
): boolean {
  return (
    left.owner === right.owner &&
    left.repo === right.repo &&
    left.number === right.number
  );
}

/**
 * Validate a `YYYY-MM-DD` calendar date, rejecting a well-shaped but impossible
 * one (`2026-02-30`). Returns the input unchanged when valid, else `null`.
 */
export function parseCalendarDate(value: string): string | null {
  const match = CALENDAR_DATE_RE.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day] = [match[1], match[2], match[3]].map((part) =>
    Number.parseInt(part, 10)
  );
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day;
  return roundTrips ? value : null;
}

/**
 * The person bridge key. Pensero sends no GitHub login, so identity is bridged
 * on email — and `username` is email-shaped but differs in CASE from `email`
 * for real users, so a case-sensitive comparison silently splits one person in
 * two. Lowercased and trimmed here, once, so no caller has to remember.
 */
export function normalizePersonEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Is `points` a measurable delivery value? A measured `0` is legal and
 * meaningful; a negative, NaN or infinite value is not a measurement and must
 * never be persisted or coerced to zero (that is exactly the false-zero this
 * feature has to keep distinguishable).
 */
export function isMeasurablePoints(points: number): boolean {
  return Number.isFinite(points) && points >= 0;
}

/**
 * The persisted `points` column is `DECIMAL(12,4)`: eight integral digits and
 * four fractional ones, so `99999999.9999` is the largest storable value.
 */
export const MAX_STORABLE_DELIVERY_POINTS = 99_999_999.9999;

/** Fractional digits the `points` column can represent. */
export const DELIVERY_POINTS_SCALE = 4;

/**
 * Can a measurable value be stored AS MEASURED? Two ways it cannot, and neither
 * may be absorbed at persist time:
 *
 * - Past `DECIMAL(12,4)`'s magnitude, Postgres raises a numeric overflow — and
 *   it raises it after every segment has already been fetched, taking the whole
 *   pass down for one row.
 * - A fifth decimal place is ROUNDED by the column, and `0.00001` rounds to
 *   `0`: a fabricated measured zero, which is precisely the zero this feature
 *   exists to keep distinguishable from "unmatched" and "not yet backfilled".
 *
 * Rejecting here, at the ingest boundary, keeps the row countable as missing
 * instead of silently restating the provider's measurement as a different one.
 */
export function isStorablePoints(points: number): boolean {
  if (points > MAX_STORABLE_DELIVERY_POINTS) {
    return false;
  }
  return Number(points.toFixed(DELIVERY_POINTS_SCALE)) === points;
}

/**
 * The inverse of {@link pullRequestRefFullName}: rebuild a ref from a stored
 * `owner/repo` and number. Used to carry an interaction's already-established
 * pull request forward from rows persisted by an EARLIER backfill run, so a
 * creator row is not re-derived as unresolved just because its reviewer's row
 * fell outside this run's window. Returns `null` for anything that is not the
 * canonical two-segment shape — a stored value is still parsed, never assumed.
 */
export function parsePullRequestRefFullName(
  fullName: string,
  number: number
): PenseroPullRequestRef | null {
  const match = FULL_NAME_RE.exec(fullName);
  if (!(match && Number.isSafeInteger(number)) || number <= 0) {
    return null;
  }
  return {
    owner: match[1].toLowerCase(),
    repo: match[2].toLowerCase(),
    number,
  };
}
