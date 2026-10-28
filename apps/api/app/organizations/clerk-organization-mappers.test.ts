import { describe, expect, it } from "vitest";
import {
  clerkEpochToIso,
  toOrganizationMemberSummary,
  toPendingInvitationSummary,
} from "./clerk-organization-mappers";

const CREATED_MS = 1_788_460_403_425;
const UPDATED_MS = 1_788_470_403_425;
const EXPIRES_MS = 1_789_065_203_425;
// Pinned literals rather than `new Date(ms).toISOString()`: re-deriving the
// expectation with the implementation's own formula would survive a unit
// confusion, which is the mistake worth catching here.
const CREATED_ISO = "2026-09-03T18:33:23.425Z";
const UPDATED_ISO = "2026-09-03T21:20:03.425Z";
const EXPIRES_ISO = "2026-09-10T18:33:23.425Z";

function membership(overrides = {}) {
  return {
    id: "orgmem_1",
    userId: "user_1",
    role: "org:admin",
    identifier: "member@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    imageUrl: "https://img.clerk.com/ada",
    createdAt: CREATED_MS,
    updatedAt: UPDATED_MS,
    ...overrides,
  };
}

function invitation(overrides = {}) {
  return {
    id: "orginv_1",
    emailAddress: "invitee@example.com",
    role: "org:member",
    status: "pending",
    createdAt: CREATED_MS,
    updatedAt: UPDATED_MS,
    expiresAt: EXPIRES_MS,
    ...overrides,
  };
}

describe("clerkEpochToIso", () => {
  it("converts provider epoch milliseconds to an ISO instant", () => {
    expect(clerkEpochToIso(CREATED_MS)).toBe(CREATED_ISO);
  });

  it("answers an unrepresentable timestamp with null, not an invalid date", () => {
    expect(clerkEpochToIso(Number.NaN)).toBeNull();
    expect(clerkEpochToIso(Number.POSITIVE_INFINITY)).toBeNull();
    expect(clerkEpochToIso(8.64e15 + 1)).toBeNull();
  });

  it("answers an omitted provider field with null rather than 1970", () => {
    // The realistic trigger, and the one a plain `new Date(value)` gets wrong:
    // `null` coerces to epoch zero, which reads as a real measured instant.
    expect(clerkEpochToIso(undefined as unknown as number)).toBeNull();
    expect(clerkEpochToIso(null as unknown as number)).toBeNull();
  });
});

describe("toOrganizationMemberSummary", () => {
  it("maps a populated membership and converts its timestamp", () => {
    expect(toOrganizationMemberSummary(membership())).toEqual({
      userId: "user_1",
      identifier: "member@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      imageUrl: "https://img.clerk.com/ada",
      role: "org:admin",
      createdAt: CREATED_ISO,
    });
  });

  it("carries absent identity through as nulls rather than placeholders", () => {
    const summary = toOrganizationMemberSummary(
      membership({
        userId: null,
        identifier: null,
        firstName: null,
        lastName: null,
        imageUrl: null,
      })
    );

    expect(summary).toMatchObject({
      userId: null,
      identifier: null,
      firstName: null,
      lastName: null,
      imageUrl: null,
    });
    expect(summary.role).toBe("org:admin");
  });

  it("passes an unrecognized provider role through verbatim", () => {
    expect(
      toOrganizationMemberSummary(membership({ role: "org:billing_manager" }))
        .role
    ).toBe("org:billing_manager");
  });

  it("keeps the row when the timestamp is unreadable, reporting it as null", () => {
    const summary = toOrganizationMemberSummary(
      membership({ createdAt: Number.NaN })
    );

    expect(summary.createdAt).toBeNull();
    expect(summary.userId).toBe("user_1");
    expect(summary.identifier).toBe("member@example.com");
  });
});

describe("toPendingInvitationSummary", () => {
  it("maps a populated invitation and converts all three timestamps", () => {
    expect(toPendingInvitationSummary(invitation())).toEqual({
      invitationId: "orginv_1",
      emailAddress: "invitee@example.com",
      role: "org:member",
      status: "pending",
      createdAt: CREATED_ISO,
      updatedAt: UPDATED_ISO,
      expiresAt: EXPIRES_ISO,
    });
  });

  it("omits status when the provider reported none, rather than stamping pending", () => {
    const { status, ...withoutStatus } = invitation();
    expect(status).toBe("pending");

    const summary = toPendingInvitationSummary(withoutStatus);

    expect(summary).not.toHaveProperty("status");
    expect(summary.invitationId).toBe("orginv_1");
  });

  it("nulls only the unreadable timestamp, keeping the other two", () => {
    const summary = toPendingInvitationSummary(
      invitation({ expiresAt: Number.NaN })
    );

    expect(summary.expiresAt).toBeNull();
    expect(summary.createdAt).toBe(CREATED_ISO);
    expect(summary.updatedAt).toBe(UPDATED_ISO);
  });
});
