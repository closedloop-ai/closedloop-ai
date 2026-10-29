/**
 * The Pensero *delivery feed* contract (ISS-8399).
 *
 * Not the person-centric `/delivery-metrics/` projection (its normalization
 * module was deleted by ISS-11588). This module describes the verified
 * `GET /api/v1/delivery?start_date=&end_date=&team_identifiers=` response: a
 * per-person list of DELIVERY ROWS, each awarding a point value for one
 * interaction (a PR authored, a PR reviewed, a Slack message, a ticket).
 *
 * Everything here is pure data shape. Parsing lives in `./delivery-parse`, the
 * boundary schema in `./delivery-extractor`, and the intra-feed join in
 * `./delivery-interaction-join`.
 */

/**
 * What kind of interaction a delivery row awards points for.
 *
 * `Other` is a real member, not a parse failure: the provider owns this
 * vocabulary and may add to it at any time, and dropping an unrecognized row
 * would silently under-report delivery. An `Other` row is retained with its
 * verbatim wire value (see `rawItemType`) so an operator can see what arrived,
 * and is never matched to a pull request.
 */
export const PenseroDeliveryItemType = {
  /** The row's person AUTHORED a pull request. Carries the large values. */
  PullRequest: "pull_request",
  /** The row's person REVIEWED a pull request. Carries the PR number. */
  PullRequestReview: "pull_request_review",
  /** A Slack message. `url` is null; there is no PR to attach to. */
  Messaging: "messaging",
  /** A ticket in Pensero's own ticketing view. Not one of our artifacts. */
  Ticket: "ticket",
  /** A value the provider added after this contract was written. */
  Other: "other",
} as const;
export type PenseroDeliveryItemType =
  (typeof PenseroDeliveryItemType)[keyof typeof PenseroDeliveryItemType];

/**
 * The person's role in the interaction. One pull request yields a `Creator` row
 * plus N `Reviewer` rows to different people, so a row's role is what decides
 * whose delivery it is.
 *
 * WHICH ROLE FEEDS THE NUMERATOR was settled by operator ruling on 2026-09-09
 * (ISS-9811/ISS-9813): ALL FOUR contribute and their SUM is the numerator, with
 * no role predicate. Pensero apportions upstream — one pull request's value is
 * DIVIDED across its role rows rather than replicated to each — so a row's
 * `points` is a per-row SHARE, and summing every role reconstructs the
 * interaction's value exactly once. Summing only `Creator` would UNDER-count by
 * discarding the shares assigned to its reviewers. `role` is retained so future
 * features can slice by it, not as a filter on the numerator.
 *
 * `apps/api/lib/delivery-points/delivery-point-attribution.ts` implements that
 * ruling. This contract still does not SETTLE the question — it records the
 * answer so a reader does not re-open it. `Other` exists for the same
 * forward-compatibility reason as above, and counts like any other share.
 */
export const PenseroDeliveryRole = {
  Creator: "creator",
  Reviewer: "reviewer",
  Assignee: "assignee",
  Other: "other",
} as const;
export type PenseroDeliveryRole =
  (typeof PenseroDeliveryRole)[keyof typeof PenseroDeliveryRole];

/**
 * The kind of entity a delivery row's `url` points at. `url` is the ONLY
 * intra-feed join key: a creator row carries no PR number, and the review rows
 * that do carry one share the creator's `url`.
 */
export const PenseroInteractionKind = {
  PullRequest: "pull_request",
  Ticket: "ticket",
} as const;
export type PenseroInteractionKind =
  (typeof PenseroInteractionKind)[keyof typeof PenseroInteractionKind];

/** A parsed `url`: which kind of interaction, and its provider-side id. */
export type PenseroInteractionRef = {
  readonly kind: PenseroInteractionKind;
  /** Provider-side interaction id, verbatim. Join key WITHIN the feed. */
  readonly id: string;
};

export type PenseroPullRequestRef = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

/**
 * The person a delivery row belongs to.
 *
 * There is NO GitHub login in the payload — identity has to be bridged on
 * email, case-insensitively (`username` is email-shaped and differs in case
 * from `email` for at least one real user). `email` here is already lowercased;
 * `rawEmail` keeps what the provider actually sent.
 */
export type PenseroDeliveryPerson = {
  /** Provider-side person id, as a string (the wire value is numeric). */
  readonly providerPersonId: string;
  readonly name: string;
  /** Lowercased bridge key. Never compare on anything else. */
  readonly email: string;
  readonly rawEmail: string;
  readonly rawUsername: string;
};

/**
 * One extracted delivery row, flattened out of the per-person envelope.
 *
 * `points` is a MEASURED value and `0` is one of its legal measurements. It
 * must never be conflated with "we could not match this row" or "this window
 * has not been backfilled" — three distinct zeros, and collapsing them is the
 * false-completeness defect this repo already tracks.
 */
export type PenseroDeliveryRow = {
  /** Provider-side row id. The idempotency key: upsert on it, never sum. */
  readonly itemId: string;
  readonly itemType: PenseroDeliveryItemType;
  /** The verbatim wire `item_type`, retained even when classified `Other`. */
  readonly rawItemType: string;
  readonly role: PenseroDeliveryRole;
  /** The verbatim wire `role`, retained even when classified `Other`. */
  readonly rawRole: string;
  /** Measured points. Finite and >= 0; `0` is a real measurement. */
  readonly points: number;
  /** The provider's `date`, as the `YYYY-MM-DD` string it sent. */
  readonly deliveredOn: string;
  readonly title: string;
  /** Parsed `url`. Null for rows with no url (messaging) or an unknown shape. */
  readonly interaction: PenseroInteractionRef | null;
  /**
   * The PR named IN THIS ROW's own title. Only `pull_request_review` rows carry
   * one; a creator row is always `null` here and gets its PR through the
   * interaction join instead.
   */
  readonly pullRequest: PenseroPullRequestRef | null;
  readonly person: PenseroDeliveryPerson;
};

/**
 * Why a row present in the response was NOT turned into a
 * {@link PenseroDeliveryRow}. A rejected row is counted and reported, never
 * silently dropped and never persisted with a coerced value.
 */
export const PenseroDeliveryRejectionReason = {
  /** The row did not match the boundary schema at all. */
  MalformedRow: "malformed_row",
  /** `delivery` was negative, NaN, or infinite — not a measurable value. */
  NonMeasurablePoints: "non_measurable_points",
  /**
   * `delivery` was a real measurement but is not storable AS MEASURED: past the
   * magnitude of the persisted `DECIMAL(12,4)` column, or carrying a fifth
   * decimal place that the column would round. Kept apart from
   * `NonMeasurablePoints` because the provider is not at fault here and the
   * remedy is ours, not theirs.
   */
  PointsOutOfDomain: "points_out_of_domain",
  /** `date` was not a `YYYY-MM-DD` calendar date. */
  MalformedDate: "malformed_date",
  /**
   * `item_id` was blank. It is the idempotency key, so a blank one is not a row
   * we can store: two such rows would upsert over each other under one key and
   * both would still be counted as extracted.
   */
  BlankItemId: "blank_item_id",
  /** The person envelope had no usable email, so identity cannot be bridged. */
  UnbridgeablePerson: "unbridgeable_person",
} as const;
export type PenseroDeliveryRejectionReason =
  (typeof PenseroDeliveryRejectionReason)[keyof typeof PenseroDeliveryRejectionReason];

/** One rejected row, with enough context to diagnose it and nothing secret. */
export type PenseroDeliveryRejection = {
  readonly reason: PenseroDeliveryRejectionReason;
  /** The row's `item_id` when it was readable; null when it was not. */
  readonly itemId: string | null;
};

/**
 * One extracted segment of the delivery feed — the rows for one
 * `[startDate, endDate]` window, plus what was rejected getting there.
 *
 * `rowsRejected` being non-empty does NOT invalidate `rows`; it means the
 * segment's coverage is short by exactly those rows, which the caller reports
 * rather than absorbs.
 */
export type PenseroDeliverySegment = {
  readonly startDate: string;
  readonly endDate: string;
  readonly rows: readonly PenseroDeliveryRow[];
  readonly rowsRejected: readonly PenseroDeliveryRejection[];
  /** People present in the response, including those with zero rows. */
  readonly peopleSeen: number;
  /**
   * Person envelopes that failed the boundary schema. Counted SEPARATELY from
   * `rowsRejected`, which counts rows: a malformed person carrying ten rows
   * loses ten rows, one carrying none loses none, and folding either into a
   * single "one person, one rejection" tally misstates the population.
   */
  readonly peopleRejected: number;
};
