/**
 * The alert's "why": picking one reason out of a run's failed days, and getting
 * it past the redaction rules the Slack channel imposes.
 *
 * The incident this answers reported `days=8 daysOk=0 daysFailed=8 rows=0` and
 * no cause at all, while every one of those eight days had already recorded the
 * same 404 in the ledger.
 */

import { PenseroDeliveryRequestError } from "@repo/pensero/delivery-client";
import { describe, expect, it } from "vitest";
import {
  buildDegradedAlertMessage,
  type FailedUnit,
  FailureSummaryScope,
  formatFailureSummary,
  sanitizeFailureReason,
  summarizeFailureReasons,
} from "../failure-reason";

const NOT_FOUND =
  "Pensero delivery request failed: 404 (endpoint=/v1/delivery basePathSegments=0)";
const TIMEOUT = "The operation was aborted due to timeout";
const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";

/** `count` failed units, all from one organization, all with one reason. */
function failed(
  organizationId: string,
  reason: string,
  count = 1
): FailedUnit[] {
  return Array.from({ length: count }, () => ({ organizationId, reason }));
}

describe("summarizeFailureReasons", () => {
  it("returns null when no day failed", () => {
    expect(summarizeFailureReasons([])).toBeNull();
  });

  it("names the reason all eight failed days shared", () => {
    const summary = summarizeFailureReasons(failed(ORG_A, NOT_FOUND, 8));

    expect(summary).toEqual({
      reason: NOT_FOUND,
      count: 8,
      distinctReasons: 1,
      organizationIds: [ORG_A],
      organizationsOmitted: 0,
    });
  });

  it("picks the MOST COMMON reason and still reports how many others there were", () => {
    const summary = summarizeFailureReasons([
      ...failed(ORG_A, TIMEOUT),
      ...failed(ORG_A, NOT_FOUND, 2),
      ...failed(ORG_A, "fetch failed"),
    ]);

    // A run where one cause dominates and two stragglers exist is a different
    // incident from a run with one cause, and the count is what says so.
    expect(summary?.reason).toBe(NOT_FOUND);
    expect(summary?.count).toBe(2);
    expect(summary?.distinctReasons).toBe(3);
  });

  it("breaks a tie deterministically so one incident reads as one incident", () => {
    const first = summarizeFailureReasons([
      ...failed(ORG_A, TIMEOUT),
      ...failed(ORG_A, NOT_FOUND),
    ]);
    const reversed = summarizeFailureReasons([
      ...failed(ORG_A, NOT_FOUND),
      ...failed(ORG_A, TIMEOUT),
    ]);

    expect(first?.reason).toBe(reversed?.reason);
    expect(first?.count).toBe(1);
  });

  it("counts DISTINCT reasons before sanitizing, so a redaction cannot merge two", () => {
    // Both sanitize to the same text once their queries are stripped. They are
    // still two different failures and the count must say two.
    const summary = summarizeFailureReasons([
      ...failed(ORG_A, "GET /api/v1/delivery?start_date=2026-08-01 failed"),
      ...failed(ORG_A, "GET /api/v1/delivery?start_date=2026-08-02 failed"),
    ]);

    expect(summary?.distinctReasons).toBe(2);
  });
});

/**
 * ISS-9689. The production alarm said `orgs=1 … daysFailed=11
 * dominantFailure="… 404 …"` and never named the one organization it was about,
 * so whoever got paged had to go and find which tenant the run even concerned.
 * The org id was already on every per-org failure log — it simply never reached
 * the line a human reads.
 */
describe("the dominant failure names its own subject", () => {
  it("names the organization whose days carried the dominant reason", () => {
    const summary = summarizeFailureReasons(failed(ORG_A, NOT_FOUND, 11));

    expect(summary?.organizationIds).toEqual([ORG_A]);
  });

  it("names only the organizations that carried the DOMINANT reason", () => {
    // The negative control for the case above. An org that failed for an
    // unrelated cause, named beside this message, sends an operator to the
    // wrong tenant with the wrong diagnosis.
    const summary = summarizeFailureReasons([
      ...failed(ORG_A, NOT_FOUND, 3),
      ...failed(ORG_B, TIMEOUT, 1),
    ]);

    expect(summary?.reason).toBe(NOT_FOUND);
    expect(summary?.organizationIds).toEqual([ORG_A]);
    expect(summary?.organizationIds).not.toContain(ORG_B);
  });

  it("names every organization sharing one cause, deduplicated and ordered", () => {
    const summary = summarizeFailureReasons([
      ...failed(ORG_B, NOT_FOUND, 2),
      ...failed(ORG_A, NOT_FOUND, 2),
    ]);

    // Sorted, so two runs of the same incident produce the same alert text; a
    // set, so four failed days across two tenants names two tenants.
    expect(summary?.organizationIds).toEqual([ORG_A, ORG_B]);
    expect(summary?.count).toBe(4);
  });

  it("caps the named list and COUNTS the rest instead of truncating silently", () => {
    // A fleet-wide provider outage must not turn one alert line into a tenant
    // roster — but "5 named" and "5 named of 8" are different incidents, so the
    // remainder is reported rather than dropped.
    const summary = summarizeFailureReasons(
      Array.from({ length: 8 }, (_, index) => ({
        organizationId: `org-${index}`,
        reason: NOT_FOUND,
      }))
    );

    expect(summary?.organizationIds).toHaveLength(5);
    expect(summary?.organizationsOmitted).toBe(3);
  });
});

describe("sanitizeFailureReason", () => {
  it("KEEPS the path — the positive control for every removal below", () => {
    expect(sanitizeFailureReason(NOT_FOUND)).toBe(NOT_FOUND);
    expect(sanitizeFailureReason("GET /api/v1/delivery?x=1 failed")).toContain(
      "/api/v1/delivery"
    );
  });

  it("replaces an ABSOLUTE URL whole — host and base path, not just the query", () => {
    // whitlockk (#6639). Stripping only the query left the tenant host and the
    // org-configured base path intact, and `isSecureHttpsUrl` constrains
    // neither. A transport error quotes the whole URL, which is a different code
    // path from the descriptor the client constructs.
    const sanitized = sanitizeFailureReason(
      "GET https://tenant.example/private/customer-42/v1/delivery?start_date=2026-08-01&team_identifiers=Engineering failed"
    );

    for (const forbidden of [
      "tenant.example",
      "customer-42",
      "private",
      "team_identifiers",
      "start_date",
      "Engineering",
    ]) {
      expect(sanitized).not.toContain(forbidden);
    }
    // The marker appears only because a URL was actually matched, and the prose
    // around it survives so the reason stays diagnosable.
    expect(sanitized).toBe("GET [redacted-url] failed");
  });

  it("drops the query from a root-relative target but keeps its path", () => {
    expect(
      sanitizeFailureReason("GET /v1/delivery?start_date=2026-08-01 failed")
    ).toBe("GET /v1/delivery failed");
  });

  it("scrubs credential-shaped text and email addresses", () => {
    const sanitized = sanitizeFailureReason(
      "rejected for ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa on behalf of person@example.com"
    );

    expect(sanitized).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(sanitized).not.toContain("person@example.com");
    expect(sanitized).toContain("rejected for");
  });

  it("caps a pathological upstream message instead of filling the channel", () => {
    const sanitized = sanitizeFailureReason("x".repeat(5000));

    expect(sanitized.length).toBeLessThan(250);
    expect(sanitized.endsWith("…")).toBe(true);
  });

  it("adds no truncation marker to a reason that fits", () => {
    expect(sanitizeFailureReason("fetch failed")).toBe("fetch failed");
  });

  /**
   * ISS-9689. The client now appends a plain-words remedy to a doubled-path
   * failure, and that remedy is only worth anything if it arrives whole. This
   * asserts it against the REAL error the client throws rather than a copy of
   * its wording, so a future edit that pushes the sentence past the cap — or
   * that puts an absolute URL in it, which `ABSOLUTE_URL_RE` would replace
   * wholesale — fails here instead of shipping a diagnosis cut off mid-sentence.
   */
  it("passes the doubled-path remedy through whole", () => {
    const reason = new PenseroDeliveryRequestError(404, 3, true).message;

    const sanitized = sanitizeFailureReason(reason);

    expect(sanitized).toBe(reason);
    expect(sanitized).toContain("already ends in /v1/delivery");
    expect(sanitized.endsWith("…")).toBe(false);
  });
});

describe("formatFailureSummary", () => {
  it("renders the reason, both counts, and the subject in the alert's key=value shape", () => {
    expect(
      formatFailureSummary(
        {
          reason: NOT_FOUND,
          count: 8,
          distinctReasons: 1,
          organizationIds: [ORG_A],
          organizationsOmitted: 0,
        },
        FailureSummaryScope.Day
      )
    ).toBe(
      `dominantFailure="${NOT_FOUND}" dominantFailureDays=8 distinctFailureReasons=1 dominantFailureOrgIds="${ORG_A}"`
    );
  });

  it("labels an ORGANIZATION-scoped count as organizations, not days", () => {
    // whitlockk (#6747). The validation probe samples exactly ONE day per tenant,
    // so seven bad credentials is seven failed ORGANIZATIONS. Rendering that
    // under the sweep's `dominantFailureDays` claimed seven failed days from a
    // single day's sample — a number that cannot be reconciled with the run.
    const formatted = formatFailureSummary(
      {
        reason: NOT_FOUND,
        count: 7,
        distinctReasons: 1,
        organizationIds: [ORG_A],
        organizationsOmitted: 0,
      },
      FailureSummaryScope.Organization
    );

    expect(formatted).toContain("dominantFailureOrgs=7");
    expect(formatted).not.toContain("dominantFailureDays");
  });

  it("keeps the id list under a DIFFERENT key from the organization COUNT", () => {
    // `dominantFailureOrgs` is a number under the organization scope. If the id
    // list reused that key, one key would mean a count in one scope and a list
    // in the other and the line would stop being parseable.
    const formatted = formatFailureSummary(
      {
        reason: NOT_FOUND,
        count: 7,
        distinctReasons: 1,
        organizationIds: [ORG_A, ORG_B],
        organizationsOmitted: 0,
      },
      FailureSummaryScope.Organization
    );

    expect(formatted).toContain(`dominantFailureOrgIds="${ORG_A},${ORG_B}"`);
    expect(formatted).toContain("dominantFailureOrgs=7");
  });

  it("reports the omitted remainder only when there IS one", () => {
    const capped = formatFailureSummary(
      {
        reason: NOT_FOUND,
        count: 8,
        distinctReasons: 1,
        organizationIds: [ORG_A],
        organizationsOmitted: 3,
      },
      FailureSummaryScope.Day
    );
    const complete = formatFailureSummary(
      {
        reason: NOT_FOUND,
        count: 8,
        distinctReasons: 1,
        organizationIds: [ORG_A],
        organizationsOmitted: 0,
      },
      FailureSummaryScope.Day
    );

    expect(capped).toContain("dominantFailureOrgIdsOmitted=3");
    expect(complete).not.toContain("dominantFailureOrgIdsOmitted");
  });
});

describe("buildDegradedAlertMessage", () => {
  it("appends the cause when failed days had one", () => {
    expect(
      buildDegradedAlertMessage(
        {
          reason: NOT_FOUND,
          count: 8,
          distinctReasons: 1,
          organizationIds: [ORG_A],
          organizationsOmitted: 0,
        },
        "days=8 daysFailed=8"
      )
    ).toBe(
      `Pensero delivery backfill ran degraded: days=8 daysFailed=8 dominantFailure="${NOT_FOUND}" dominantFailureDays=8 distinctFailureReasons=1 dominantFailureOrgIds="${ORG_A}"`
    );
  });

  it("says nothing about a cause when no day failed", () => {
    // A truncation-signalled run is degraded with `daysFailed=0`. Naming a
    // dominant reason there would report a failure that did not happen.
    expect(buildDegradedAlertMessage(null, "days=8 daysFailed=0")).toBe(
      "Pensero delivery backfill ran degraded: days=8 daysFailed=0"
    );
  });
});
