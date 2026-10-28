/**
 * ISS-11147: the UNWIRED register's under-report guard.
 *
 * Its two siblings in
 * `../../components/__tests__/guided-onboarding-honest-data.test.tsx` check that
 * every entry has an owner, a surface, and a matching fixture. Nothing checked
 * that a registered field was still FAKE, so the register could only ever
 * over-report — and it did, for seven fields, telling a reader asking "is this
 * number real yet?" that shipped data was a placeholder.
 *
 * The list below is written out BY HAND rather than derived from
 * `UNWIRED_GUIDED_ONBOARDING_DATA`, because a fixture built from the very const
 * it polices stays green when an entry is deleted. The duplication is the test.
 *
 * Each field below has its own production producer EXECUTED through
 * {@link FIELD_PRODUCERS}, so the list cannot rot into a claim nobody checks:
 * delete a producer and the same case fails from the other direction.
 *
 * WHAT THAT DOES AND DOES NOT ESTABLISH (tamsinb review). Every probe here
 * calls a FOLD on inputs this file builds, so it proves the producer exists and
 * yields a value, and it proves the six names stay out of the register. It does
 * not touch a host, so on its own it would stay green if the value never
 * reached the user. The arrival half is
 * `../../components/__tests__/guided-onboarding-wired-field-arrival.test.tsx`,
 * which renders the real shared host and reads the sentence the folded value
 * produced — delete `members={members}` or `discovery={discovery}` from
 * `guided-onboarding-dialog-host.tsx` and that file reddens.
 *
 * Two hops stay outside both files, named rather than implied. `account.email`
 * is retired on the same rule but absent below, because its producers are
 * Clerk's `useUser` in
 * `apps/app/app/(authenticated)/components/guided-onboarding-dialog-host.tsx`
 * and the identity bridge in
 * `apps/desktop/src/renderer/components/onboarding/desktop-guided-onboarding-dialog-host.tsx`.
 * The desktop host's own `discovery={discovery.discovery}` is likewise in
 * `apps/desktop`. Neither is reachable from this package, so this guard's reach
 * is the six below and the shared host's hop for them.
 */

import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import { describe, expect, it } from "vitest";
import {
  OnboardingAnalysisEstimateStatus,
  type OnboardingOrganizationMembers,
  type OnboardingSessionDiscovery,
} from "../../components/guided-onboarding-data";
import { UNWIRED_GUIDED_ONBOARDING_DATA } from "../guided-onboarding-fixtures";
import { foldOnboardingOrganizationMembers } from "../onboarding-organization-members";
import {
  foldOnboardingSessionDiscovery,
  OnboardingEnumerationQuality,
} from "../onboarding-session-discovery";

const SIGNER_ID = "user-signer";
const TEAMMATE_ID = "user-teammate";
const HARNESS = "claude";
const FOUND_SESSIONS = 41;
const ANALYZED_SESSIONS = 17;
const LOG_BYTES = 1_234_567;
const REMAINING_MINUTES = 9;

/**
 * Every field ISS-11147 retired and can prove retired from this package. A field
 * here must NOT appear in the register.
 */
const PRODUCER_BACKED_FIELDS = [
  "discovery.estimate",
  "discovery.logBytes",
  "discovery.sessionsFound",
  "discovery.sources",
  "members.count",
  "members.preview",
] as const;

type ProducerBackedField = (typeof PRODUCER_BACKED_FIELDS)[number];

describe("unwired-data register, under-report guard", () => {
  it("does not name a field whose production producer already yields a value", () => {
    for (const field of PRODUCER_BACKED_FIELDS) {
      expect(FIELD_PRODUCERS[field](), `${field} producer`).toBeDefined();
      expect(
        Object.hasOwn(UNWIRED_GUIDED_ONBOARDING_DATA, field),
        `${field} is wired, so the register must not name it`
      ).toBe(false);
    }
  });

  it("still names the halves no producer feeds", () => {
    // Paired control: the assertion above is satisfied by an empty register, so
    // one that drops a genuinely unwired field has to fail too. Both survivors
    // are a missing HALF — an invitation the visitor is not yet a member of, and
    // a company inferred from the email domain — and each production path feeds
    // the other half instead.
    expect(Object.keys(UNWIRED_GUIDED_ONBOARDING_DATA).sort()).toEqual([
      "joinableOrganization.name",
      "organizationName",
    ]);
  });
});

/**
 * One probe per field, each executing that field's own production producer.
 *
 * A `Record` keyed by the field union rather than a lookup over `string`: a
 * member added to {@link PRODUCER_BACKED_FIELDS} cannot compile without its own
 * probe here, so the list can never carry a field whose producer was silently
 * never consulted.
 */
const FIELD_PRODUCERS: Record<ProducerBackedField, () => unknown> = {
  "discovery.estimate": () => {
    const estimate = measuredDiscovery()?.estimate;
    return estimate?.status === OnboardingAnalysisEstimateStatus.Measured
      ? estimate.remainingMinutes
      : undefined;
  },
  "discovery.logBytes": () => measuredDiscovery()?.logBytes,
  "discovery.sessionsFound": () => measuredDiscovery()?.sessionsFound,
  "discovery.sources": () => measuredDiscovery()?.sources,
  "members.count": () => knownMembers()?.count,
  "members.preview": () => knownMembers()?.preview,
};

/** The production discovery fold over one host's measurements. */
function measuredDiscovery(): Extract<
  OnboardingSessionDiscovery,
  { status: "measured" }
> | null {
  const { discovery } = foldOnboardingSessionDiscovery({
    absent: [],
    analyzed: [{ harness: HARNESS, sessions: ANALYZED_SESSIONS }],
    bytes: null,
    estimate: {
      remainingMinutes: REMAINING_MINUTES,
      status: OnboardingAnalysisEstimateStatus.Measured,
    },
    found: [{ harness: HARNESS, sessions: FOUND_SESSIONS }],
    label: (harness) => `Label:${harness}`,
    logBytes: LOG_BYTES,
    quality: OnboardingEnumerationQuality.Whole,
  });
  return discovery.status === "measured" ? discovery : null;
}

/** The production roster fold over a resolved `GET /users` read. */
function knownMembers(): Extract<
  OnboardingOrganizationMembers,
  { status: "known" }
> | null {
  const members = foldOnboardingOrganizationMembers(
    {
      status: "resolved",
      users: [makeUser(SIGNER_ID), makeUser(TEAMMATE_ID)],
    },
    SIGNER_ID
  );
  return members.status === "known" ? members : null;
}

function makeUser(id: string): User {
  return {
    active: true,
    avatarUrl: null,
    clerkId: `clerk-${id}`,
    createdAt: new Date("2025-06-01"),
    email: `${id}@example.com`,
    firstName: "Given",
    githubUsername: null,
    id,
    lastName: null,
    linearId: null,
    organizationId: "org-1",
    phoneNumber: null,
    role: ApproverRole.Engineer,
    slackId: null,
    updatedAt: new Date("2025-06-01"),
  };
}
