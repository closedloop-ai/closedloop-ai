/**
 * Hazard suite for the delivery-feed parsers. Every case below is named for the
 * hazard in `fixtures/pensero-delivery-hazards.fixture.json` it pins, and the
 * strings follow the shape of a Pensero response; names, titles and scores
 * are invented.
 */

import { describe, expect, it } from "vitest";
import {
  PenseroDeliveryItemType,
  PenseroDeliveryRole,
  PenseroInteractionKind,
} from "../delivery-contract";
import {
  classifyDeliveryItemType,
  classifyDeliveryRole,
  isMeasurablePoints,
  isStorablePoints,
  MAX_STORABLE_DELIVERY_POINTS,
  normalizePersonEmail,
  parseCalendarDate,
  parseInteractionUrl,
  parsePullRequestRefFullName,
  parseReviewPullRequestRef,
  pullRequestRefFullName,
  samePullRequestRef,
} from "../delivery-parse";

describe("parseInteractionUrl (H2: url is the intra-feed join key)", () => {
  it("parses a pull-request interaction path", () => {
    expect(parseInteractionUrl("/interactions/pull_request/1539716")).toEqual({
      kind: PenseroInteractionKind.PullRequest,
      id: "1539716",
    });
  });

  it("parses a ticketing path as a ticket, not a pull request", () => {
    // H10: a ticket row carries real points and has no pull request. Folding
    // its url into the pull-request kind would send it to the PR matcher.
    expect(parseInteractionUrl("/ticketing/ticket/2608131")).toEqual({
      kind: PenseroInteractionKind.Ticket,
      id: "2608131",
    });
  });

  it("returns null for a messaging row's absent url", () => {
    expect(parseInteractionUrl(null)).toBeNull();
    expect(parseInteractionUrl(undefined)).toBeNull();
    expect(parseInteractionUrl("")).toBeNull();
  });

  it("does not coerce an unrecognized path into a pull-request interaction", () => {
    expect(parseInteractionUrl("/interactions/deployment/99")).toBeNull();
    expect(
      parseInteractionUrl("https://pensero.ai/interactions/pull_request/1")
    ).toBeNull();
  });
});

describe("parseReviewPullRequestRef", () => {
  it("H1/H2: reads owner, repo and number from a review title", () => {
    expect(
      parseReviewPullRequestRef(
        "Review pull_request: closedloop-ai/closedloop-ai#4228 with title 'ISS-4881: Add a widget export contract'"
      )
    ).toEqual({
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      number: 4228,
    });
  });

  it("H4: parses the repository rather than assuming closedloop-ai", () => {
    expect(
      parseReviewPullRequestRef(
        "Review pull_request: example-org/infrastructure#148 with title 'ISS-5023: bound widget log spend in IaC (scoped index + usage monitors)'"
      )
    ).toEqual({
      owner: "example-org",
      repo: "infrastructure",
      number: 148,
    });
  });

  it("H7: takes only the number, ignoring a title with nested quotes", () => {
    const ref = parseReviewPullRequestRef(
      "Review pull_request: closedloop-ai/closedloop-ai#4085 with title 'ISS-4573: Quarantine 'widgets couldn't be read' caveat — launched-app E2E'"
    );
    expect(ref).toEqual({
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      number: 4085,
    });
  });

  it("H6: survives a lossy title with markup stripped to a double space", () => {
    expect(
      parseReviewPullRequestRef(
        "Review pull_request: closedloop-ai/closedloop-ai#4155 with title 'ISS-4673: collapse nested/duplicate  panels to one per page'"
      )?.number
    ).toBe(4155);
  });

  it("H17: does not read a Slack channel as a pull-request number", () => {
    // `#team-ci-alerts` has no digits and, decisively, no `pull_request:`
    // anchor in front of it.
    expect(
      parseReviewPullRequestRef(
        "ISS-5023: route the widget alerts to #team-ci-alerts"
      )
    ).toBeNull();
  });

  it("H1: a creator row's bare title yields no pull request", () => {
    expect(
      parseReviewPullRequestRef("ISS-4881: Add a widget export contract")
    ).toBeNull();
  });

  it("H10: a messaging row's owner/repo#number reference is not a delivery on that PR", () => {
    // The reference is real, but it is a Slack message ABOUT a pull request.
    // Only the `pull_request: ` anchor marks delivery on one.
    expect(
      parseReviewPullRequestRef(
        "Slack Message related to: closedloop-ai/closedloop-ai#4159: PLN-1525 step 4: widget read signatures."
      )
    ).toBeNull();
  });

  it("normalizes owner/repo case for the repository identity key", () => {
    expect(
      pullRequestRefFullName(
        parseReviewPullRequestRef(
          "Review pull_request: ClosedLoop-AI/ClosedLoop-AI#12 with title 'x'"
        )!
      )
    ).toBe("closedloop-ai/closedloop-ai");
  });
});

describe("samePullRequestRef", () => {
  it("distinguishes the same number in different repositories", () => {
    // H4 again, from the other side: 148 in example-infrastructure is not 148 in
    // closedloop-ai, and treating them as one is how points cross repos.
    expect(
      samePullRequestRef(
        { owner: "closedloop-ai", repo: "closedloop-ai", number: 148 },
        { owner: "closedloop-ai", repo: "example-infrastructure", number: 148 }
      )
    ).toBe(false);
  });
});

describe("classifiers", () => {
  it("classifies the known item types", () => {
    expect(classifyDeliveryItemType("pull_request")).toBe(
      PenseroDeliveryItemType.PullRequest
    );
    expect(classifyDeliveryItemType("pull_request_review")).toBe(
      PenseroDeliveryItemType.PullRequestReview
    );
    expect(classifyDeliveryItemType("messaging")).toBe(
      PenseroDeliveryItemType.Messaging
    );
    expect(classifyDeliveryItemType("ticket")).toBe(
      PenseroDeliveryItemType.Ticket
    );
  });

  it("folds an unknown item type to Other instead of dropping the row", () => {
    expect(classifyDeliveryItemType("incident")).toBe(
      PenseroDeliveryItemType.Other
    );
  });

  it("classifies roles and folds an unknown one", () => {
    expect(classifyDeliveryRole("creator")).toBe(PenseroDeliveryRole.Creator);
    expect(classifyDeliveryRole("reviewer")).toBe(PenseroDeliveryRole.Reviewer);
    expect(classifyDeliveryRole("assignee")).toBe(PenseroDeliveryRole.Assignee);
    expect(classifyDeliveryRole("approver")).toBe(PenseroDeliveryRole.Other);
  });
});

describe("parseCalendarDate", () => {
  it("accepts a real calendar day", () => {
    expect(parseCalendarDate("2026-08-02")).toBe("2026-08-02");
  });

  it("rejects a well-shaped but impossible day", () => {
    expect(parseCalendarDate("2026-02-30")).toBeNull();
    expect(parseCalendarDate("2026-13-01")).toBeNull();
    expect(parseCalendarDate("08/02/2026")).toBeNull();
  });
});

describe("normalizePersonEmail (H11: no GitHub login, bridge on email)", () => {
  it("folds the case difference between username and email", () => {
    expect(normalizePersonEmail("Daveth.Oakhurst@closedloop.ai")).toBe(
      normalizePersonEmail("daveth.oakhurst@closedloop.ai")
    );
  });
});

describe("isMeasurablePoints (H8: zero is a measured value)", () => {
  it("accepts a measured zero", () => {
    expect(isMeasurablePoints(0)).toBe(true);
  });

  it("rejects values that are not measurements", () => {
    expect(isMeasurablePoints(-1)).toBe(false);
    expect(isMeasurablePoints(Number.NaN)).toBe(false);
    expect(isMeasurablePoints(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("isStorablePoints (the DECIMAL(12,4) domain)", () => {
  it("accepts the values the feed actually emits", () => {
    for (const points of [0, 0.1, 2.2, 16, 0.9999]) {
      expect(isStorablePoints(points)).toBe(true);
    }
  });

  it("accepts the largest value the column can hold and rejects the next one", () => {
    expect(isStorablePoints(MAX_STORABLE_DELIVERY_POINTS)).toBe(true);
    expect(isStorablePoints(100_000_000)).toBe(false);
  });

  it("rejects a fifth decimal place rather than letting it round to a false zero", () => {
    // 0.00001 is a real, positive measurement that DECIMAL(12,4) would store as
    // 0 — a fabricated measured zero, which is the one value this feature must
    // never invent.
    expect(isMeasurablePoints(0.000_01)).toBe(true);
    expect(isStorablePoints(0.000_01)).toBe(false);
    expect(isStorablePoints(1.234_56)).toBe(false);
  });
});

describe("parsePullRequestRefFullName (carrying a stored ref forward)", () => {
  it("round-trips a ref through its stored full name", () => {
    const ref = {
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      number: 4228,
    };
    expect(
      parsePullRequestRefFullName(pullRequestRefFullName(ref), ref.number)
    ).toEqual(ref);
  });

  it("normalizes case the same way the forward direction does", () => {
    expect(
      parsePullRequestRefFullName("ClosedLoop-AI/ClosedLoop-AI", 7)
    ).toEqual({ owner: "closedloop-ai", repo: "closedloop-ai", number: 7 });
  });

  it("refuses a stored value that is not the canonical two-segment shape", () => {
    expect(parsePullRequestRefFullName("closedloop-ai", 7)).toBeNull();
    expect(parsePullRequestRefFullName("a/b/c", 7)).toBeNull();
    expect(parsePullRequestRefFullName("", 7)).toBeNull();
  });

  it("refuses a number that is not a positive integer", () => {
    expect(parsePullRequestRefFullName("owner/repo", 0)).toBeNull();
    expect(parsePullRequestRefFullName("owner/repo", -1)).toBeNull();
    expect(parsePullRequestRefFullName("owner/repo", 1.5)).toBeNull();
  });
});
