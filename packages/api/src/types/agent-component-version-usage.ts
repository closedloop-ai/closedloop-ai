import type { VersionSpend } from "../utils/version-spend.js";
import type { CohortDeliveryMetrics } from "./analytics.js";

/**
 * ISS-10467 / ISS-10468 — the agent-component detail's per-CONTENT-VERSION
 * drill-down, and the side-by-side compare built on the same read.
 *
 * ISS-10341 made every aggregate on the component detail FAMILY-scoped (one
 * population per page), which deliberately removed the only way to see a single
 * byte-version's own usage. This contract restores that as an explicit
 * drill-down BESIDE the family headline, never as a re-scoping of it: the page's
 * `invocations`/`sessions`/`locPerDollar` remain the family's, and a consumer
 * renders these numbers as a clearly-subordinate subtotal.
 *
 * WHY A SEPARATE READ RATHER THAN A FIELD ON THE DETAIL. The drill-down is
 * on-demand and bounded ({@link MAX_VERSION_USAGE_ENTRIES}); computing every
 * revision's cohort aggregates on every detail load would multiply the page's
 * cost by its revision count for data nobody asked to see.
 */

/**
 * How many content versions one version-usage read may answer for.
 *
 * Each entry costs its own identity-scoped usage snapshot plus the LOC/cost and
 * cohort reads the detail runs once, so the bound is what keeps a compare from
 * turning into an unbounded fan-out. Four is two more than the side-by-side
 * compare ISS-10468 ships, so widening the UI does not immediately need a
 * contract change. A request naming more is REJECTED rather than silently
 * clamped: dropping a version the caller asked about would answer a different
 * question than the one asked.
 */
export const MAX_VERSION_USAGE_ENTRIES = 4;

/**
 * One content version's OWN usage, scoped by the shared
 * `usageContentScopeWhere` predicate (`apps/api/app/agent-components/
 * content-hash-identity.ts`) — the same primitive the token-trend read narrows
 * with. There is exactly one derivation of "this version's usage" in the repo
 * and this is its output shape.
 *
 * THE TOKEN/COST AGGREGATES ARRIVE BY INTERSECTION ({@link VersionSpend}), for
 * the same reason the cohort figures do: the arithmetic and the coverage rule
 * have one owner (`foldVersionSpend`), so the cloud and the desktop cannot
 * publish two answers to "what did this revision cost". ISS-10467 shipped
 * without them and the panel dropped a figure the producer already held; the
 * operator ruled on 2026-09-26 that they belong there for `skill` and `command`,
 * which are most of the corpus. They are NOT kind-gated the way `locPerDollar`
 * is — see `isLocPerDollarVerifiableKind` for what that gate is actually about,
 * and the consumer for the caveat a session-level kind carries beside them.
 *
 * ISS-5363 CONTRACT, UNCHANGED AND LOAD-BEARING HERE. `invocations` and
 * `sessions` are `number | null`: a `0` is a MEASURED zero (every lane issued
 * its read and this version genuinely ran nothing), and `null` is "not
 * computed". A consumer MUST render the two differently — `0` as `0`, `null` as
 * a dash. A version with no recorded usage is the common case on real data and
 * must read as the measured zero it is.
 */
export type AgentComponentVersionUsage = {
  /**
   * The revision's coarse content hash — the same value `ComponentVersion.hash`
   * carries, which is what the detail's version selector keys on.
   */
  hash: string;
  /**
   * The exact provenance-free `DefinitionVersion.definitionHash` this scope
   * resolved with, when the revision is linked. OPTIONAL and omitted (never
   * `null`) for a still-unlinked revision, matching `ComponentVersion`.
   */
  definitionHash?: string;
  /** Invocations recorded against THIS version. `0` measured, `null` not computed. */
  invocations: number | null;
  /** Distinct sessions that ran THIS version. `0` measured, `null` not computed. */
  sessions: number | null;
  /** LOC per dollar over this version's sessions; `null` when not computable. */
  locPerDollar: number | null;
  /**
   * Whether {@link invocations} and {@link sessions} are FLOORS rather than
   * totals.
   *
   * NARROWER THAN "the lane was bounded", and the difference is the whole point.
   * A bounded orphan lane usually still has a whole-population aggregate to
   * stand in for it, and then these two counts are EXACT even though a cap was
   * hit; this is true only when the lane was bounded AND that aggregate could
   * not answer, which is the one case where the counts really are floors. A
   * consumer marks them as floors on this flag and on nothing else — marking
   * them on the lane's own bound prints "at least N" over a number that is N.
   *
   * It says nothing about the SAMPLE-DERIVED figures beside them.
   * {@link CohortDeliveryMetrics.mergedPrsTruncated} carries its own coverage
   * for the cohort, and `locPerDollar` is a ratio over the bounded session set
   * whose error has no direction, so neither reads this flag.
   */
  truncated: boolean;
} & CohortDeliveryMetrics &
  VersionSpend;

/** One measured slice of a family's usage population. */
export type AgentComponentUsageSlice = {
  /** Invocations in this slice. `0` measured, `null` not computed. */
  invocations: number | null;
  /** Distinct sessions in this slice. `0` measured, `null` not computed. */
  sessions: number | null;
};

/**
 * How the FAMILY's usage divides between rows that name a content version and
 * rows that name none.
 *
 * THIS IS THE CRUX OF ISS-10467, not a footnote. Most usage rows record no
 * version at all — `componentVersionHash` and `definitionVersionId` both null
 * (32 of 36 on the `frankenstein` skill at the time of writing), and
 * `AgentComponentSessionUsage.definitionVersionId` still has no writer. Those
 * invocations cannot be attributed to any revision, so no per-version entry can
 * contain them. A drill-down that simply dropped them would understate every
 * version against a family headline that counts them, which is exactly the
 * silent-population defect ISS-10341 fixed.
 *
 * BOTH halves are reported, and deliberately so. {@link unversioned} is the
 * population no revision can ever claim. {@link versioned} is the population
 * some revision named — which is NOT the same as "the sum of the entries
 * below": a row can name a version identity that lines up with no revision in
 * this component's history, and stating the versioned total is what lets a
 * reader see that gap instead of inferring, wrongly, that the entries account
 * for everything the unversioned figure does not.
 *
 * THE PARTITION IS ON INVOCATIONS, NOT ON SESSIONS, and a consumer writing copy
 * over these numbers has to know the difference. Both slices are folded from one
 * read by one boolean over the ROW's own version columns, so the invocation
 * halves are exclusive and sum to the family total. A SESSION is not a row:
 * usage is keyed per (session, kind, key, branch), so one session can carry a
 * hash-bearing row and a hash-less one and is then counted in BOTH session
 * slices. `unversioned.sessions + versioned.sessions` can therefore exceed the
 * family's session count, and no consumer may tell a reader that the unversioned
 * sessions sit outside the per-version figures — some of them do not.
 */
export type AgentComponentUsageAttribution = {
  /** Usage carrying no version identity at all. */
  unversioned: AgentComponentUsageSlice;
  /** Usage carrying some version identity, whether or not a revision matches it. */
  versioned: AgentComponentUsageSlice;
  /**
   * Whether this partition was folded from a bounded sample of the family's
   * usage rows. When true BOTH slices are FLOORS, and the disclosure beside
   * them must say so.
   */
  truncated: boolean;
};

/**
 * `GET /agent-components/{slug}/version-usage?version=<hash>[&version=…]`.
 *
 * Deliberately does NOT restate the family totals: the consumer already holds
 * them on the detail payload it drilled down from, and re-deriving them here
 * would be a second producer of the page's headline number that could disagree
 * with the first.
 */
export type AgentComponentVersionUsageResponse = {
  /**
   * One entry per requested version, in the order requested. A version the
   * detail's history does not carry is answered with an entry whose figures are
   * `null` rather than omitted, so a compare never silently loses a column.
   */
  entries: AgentComponentVersionUsage[];
  /**
   * How the family's usage divides between versioned and version-less rows —
   * see {@link AgentComponentUsageAttribution}.
   */
  attribution: AgentComponentUsageAttribution;
};
