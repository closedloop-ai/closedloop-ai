import { redactSensitiveText } from "@repo/observability/redact";

/** Only ONE reason is ever shown, so a long one cannot dominate an alert. */
const MAX_REASON_LENGTH = 200;
const TRUNCATION_MARKER = "…";

/**
 * Any ABSOLUTE URL, replaced whole (whitlockk, #6639).
 *
 * Not just its query. A transport or SDK error quotes the URL it was given, so
 * a reason can carry `https://tenant.example/private/customer-42/v1/delivery?…`
 * — scheme, host AND configured base path — down a code path that never went
 * through the descriptor this module's callers construct. `isSecureHttpsUrl`
 * constrains the scheme, the host's publicness, and query/fragment/userinfo, but
 * NOT the path, so both the host and the path are potentially tenant-identifying
 * and neither may reach Slack. The whole run goes.
 *
 * Global, and used ONLY with `String#replace`: `.test()`/`.exec()` on a global
 * regex advance `lastIndex` and would let every other call through.
 */
const ABSOLUTE_URL_RE = /https?:\/\/\S+/gi;
const REDACTED_URL = "[redacted-url]";

/**
 * A ROOT-RELATIVE target followed by its query or fragment, replaced by capture
 * group 1 — the path without the `?`/`#` tail.
 *
 * The path is kept here and dropped by {@link ABSOLUTE_URL_RE} above, and the
 * asymmetry is deliberate: this module's own callers put a CONSTANT endpoint
 * (`/v1/delivery`) in their message, which is the diagnostic the alert exists to
 * carry and names no tenant. Residual, stated rather than hidden: a foreign
 * error that quotes a tenant-identifying path with NO scheme keeps that path.
 * Nothing in this feature produces one — the client emits the constant endpoint
 * plus a segment count, and a transport error quotes the absolute URL.
 */
const RELATIVE_TARGET_QUERY_RE = /(\/[^\s?#]*)[?#]\S*/g;

/**
 * What one run's failed units had in common, when they had anything.
 *
 * Deliberately scope-FREE: `count` is a number of failed units, and WHICH unit
 * is supplied at format time by {@link FailureSummaryScope}. The sweep fails
 * days; the on-demand validation samples exactly one day and fails
 * ORGANIZATIONS. A type that hard-codes one of those and is reused for the
 * other is how seven bad credentials came to read as seven failed days.
 */
export type FailureReasonSummary = {
  /** The most frequent reason, sanitized for the alert channel. */
  readonly reason: string;
  /** How many failed units carried that reason. */
  readonly count: number;
  /**
   * How many DISTINCT raw reasons the failed units carried. Counted before
   * sanitization, so two reasons that sanitize alike are still two reasons —
   * collapsing them would understate how many separate problems are in flight.
   */
  readonly distinctReasons: number;
  /**
   * WHICH organizations carried the dominant reason (ISS-9689), capped at
   * {@link MAX_NAMED_ORGANIZATIONS} and sorted so the same run always produces
   * the same alert.
   *
   * The alert used to say `orgs=1 … dominantFailure="… 404 …"` and never name
   * the one. Every per-org failure log already carried `organizationId`, so the
   * information existed at the point of failure and simply stopped there —
   * leaving whoever got paged to go find, by hand, which tenant the run was
   * even about. A ClosedLoop organization id is our own internal identifier
   * going to our own Slack, not provider data, so naming it costs nothing that
   * the base path (deliberately withheld, see {@link ABSOLUTE_URL_RE}) would.
   */
  readonly organizationIds: readonly string[];
  /**
   * How many FURTHER organizations carried the dominant reason beyond those
   * named. A separate number rather than a longer list, because an alert line
   * whose length scales with the tenant count is one nobody reads — and rather
   * than silent truncation, because "3 named" and "3 named of 40" are different
   * incidents.
   */
  readonly organizationsOmitted: number;
};

/** One failed unit: which organization, and why it failed. */
export type FailedUnit = {
  readonly organizationId: string;
  /** The raw, unsanitized reason. Sanitized only on the way to the alert. */
  readonly reason: string;
};

/**
 * How many organizations an alert line names before it starts counting.
 * Enough to make a small multi-tenant incident actionable on sight, small
 * enough that a fleet-wide provider outage cannot fill the channel.
 */
const MAX_NAMED_ORGANIZATIONS = 5;

/**
 * The dominant reason across a run's failed units, or `null` when none failed.
 *
 * Ties break on the lexicographically smallest reason so the same run always
 * produces the same alert; an arbitrary winner would make two identical
 * incidents read as two different ones.
 */
export function summarizeFailureReasons(
  failures: readonly FailedUnit[]
): FailureReasonSummary | null {
  if (failures.length === 0) {
    return null;
  }

  const tally = new Map<string, number>();
  const organizationsByReason = new Map<string, Set<string>>();
  for (const failure of failures) {
    tally.set(failure.reason, (tally.get(failure.reason) ?? 0) + 1);
    const organizations =
      organizationsByReason.get(failure.reason) ?? new Set<string>();
    organizations.add(failure.organizationId);
    organizationsByReason.set(failure.reason, organizations);
  }

  let dominant = "";
  let dominantCount = 0;
  for (const [reason, count] of tally) {
    if (
      count > dominantCount ||
      (count === dominantCount && reason < dominant)
    ) {
      dominant = reason;
      dominantCount = count;
    }
  }

  // Attributed to the DOMINANT reason only, never to the run: an org that
  // failed for an unrelated reason named beside this one's message would send
  // an operator to the wrong tenant with the wrong cause.
  const dominantOrganizations = [
    ...(organizationsByReason.get(dominant) ?? new Set<string>()),
  ].sort();

  return {
    reason: sanitizeFailureReason(dominant),
    count: dominantCount,
    distinctReasons: tally.size,
    organizationIds: dominantOrganizations.slice(0, MAX_NAMED_ORGANIZATIONS),
    organizationsOmitted: Math.max(
      0,
      dominantOrganizations.length - MAX_NAMED_ORGANIZATIONS
    ),
  };
}

/**
 * Strip anything an alert channel must not carry out of a failure reason.
 *
 * Four passes, in this order, because each depends on the last:
 *   1. replace any ABSOLUTE URL whole — host and configured base path are both
 *      potentially tenant-identifying, and the query carries `team_identifiers`
 *      plus the window being walked;
 *   2. drop the query/fragment from a root-relative target, keeping the path,
 *      which for this feature's own reasons is a constant endpoint;
 *   3. scrub credential-shaped runs and email addresses through
 *      `redactSensitiveText`, the repo's single vocabulary for that;
 *   4. cap the length, so one pathological upstream message cannot fill the
 *      channel.
 *
 * Reasons produced by this feature carry none of the above — the delivery client
 * emits a status, a constant endpoint and a segment count, and never the
 * response body. This is defence for the reasons it does NOT produce: a
 * transport, DNS, or provider SDK error arrives here through `parseError` with
 * whatever text its author chose, and that is the path that quotes a whole URL.
 */
export function sanitizeFailureReason(reason: string): string {
  const withoutUrls = reason.replace(ABSOLUTE_URL_RE, REDACTED_URL);
  const withoutQuery = withoutUrls.replace(RELATIVE_TARGET_QUERY_RE, "$1");
  const scrubbed = redactSensitiveText(withoutQuery);
  return scrubbed.length > MAX_REASON_LENGTH
    ? `${scrubbed.slice(0, MAX_REASON_LENGTH)}${TRUNCATION_MARKER}`
    : scrubbed;
}

/**
 * WHAT a {@link FailureReasonSummary} counted (whitlockk, #6747).
 *
 * The sweep walks many days per organization and summarizes failed DAYS. The
 * on-demand validation samples exactly one day per organization and summarizes
 * failed ORGANIZATIONS — rendering that under the day label made seven bad
 * credentials report `dominantFailureDays=7` after sampling a single day.
 */
export const FailureSummaryScope = {
  Day: "day",
  Organization: "organization",
} as const;
export type FailureSummaryScope =
  (typeof FailureSummaryScope)[keyof typeof FailureSummaryScope];

/**
 * The count key per scope. Exhaustive by type, so a new scope fails typecheck
 * here instead of silently borrowing another scope's noun.
 */
const DOMINANT_COUNT_KEY: Record<FailureSummaryScope, string> = {
  [FailureSummaryScope.Day]: "dominantFailureDays",
  [FailureSummaryScope.Organization]: "dominantFailureOrgs",
};

/**
 * The alert fragment for a summary, in the same key=value shape as the counts.
 *
 * One formatter for every scope, on purpose: a second copy per scope is how the
 * reason and the count drift apart.
 */
export function formatFailureSummary(
  summary: FailureReasonSummary,
  scope: FailureSummaryScope
): string {
  const parts = [
    `dominantFailure="${summary.reason}"`,
    `${DOMINANT_COUNT_KEY[scope]}=${summary.count}`,
    `distinctFailureReasons=${summary.distinctReasons}`,
    // A DIFFERENT key from `dominantFailureOrgs` above, which is a COUNT under
    // the organization scope. One key meaning a number in one scope and a list
    // of ids in another is how an alert stops being parseable.
    `dominantFailureOrgIds="${summary.organizationIds.join(",")}"`,
  ];
  if (summary.organizationsOmitted > 0) {
    parts.push(`dominantFailureOrgIdsOmitted=${summary.organizationsOmitted}`);
  }
  return parts.join(" ");
}

export function buildDegradedAlertMessage(
  dayFailureSummary: FailureReasonSummary | null,
  formattedCounts: string
): string {
  const base = `Pensero delivery backfill ran degraded: ${formattedCounts}`;
  return dayFailureSummary
    ? `${base} ${formatFailureSummary(dayFailureSummary, FailureSummaryScope.Day)}`
    : base;
}
