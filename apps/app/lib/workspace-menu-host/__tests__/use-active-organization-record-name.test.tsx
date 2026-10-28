import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * ISS-12135: the product's record of the active Clerk org, which is where a
 * seeded `$vibe` preview's org name lives (ISS-12056).
 */

type OrganizationRecord = { clerkId: string; name: string };

const reads = vi.hoisted(() => ({
  currentUser: undefined as { organizationId: string } | undefined,
  organization: undefined as OrganizationRecord | undefined,
  currentUserEnabled: [] as (boolean | undefined)[],
  organizationCalls: [] as { id: string; enabled: boolean | undefined }[],
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: (options?: { enabled?: boolean }) => {
    reads.currentUserEnabled.push(options?.enabled);
    return { data: reads.currentUser };
  },
}));

vi.mock("@repo/app/organizations/hooks/use-organizations", () => ({
  useOrganization: (id: string, options?: { enabled?: boolean }) => {
    reads.organizationCalls.push({ id, enabled: options?.enabled });
    return { data: reads.organization };
  },
}));

const { useActiveOrganizationRecordName } = await import(
  "../use-active-organization-record-name"
);

const CLERK_ORG_ID = "org_2realclosedloop";

beforeEach(() => {
  reads.currentUser = { organizationId: "db-org-1" };
  reads.organization = { clerkId: CLERK_ORG_ID, name: "Acme Co" };
  reads.currentUserEnabled = [];
  reads.organizationCalls = [];
});

function read(clerkOrganizationId: string | null) {
  return renderHook(() => useActiveOrganizationRecordName(clerkOrganizationId))
    .result.current;
}

describe("useActiveOrganizationRecordName", () => {
  test("names the active Clerk org from the product's record of it", () => {
    expect(read(CLERK_ORG_ID)).toBe("Acme Co");
    expect(reads.organizationCalls).toContainEqual({
      id: "db-org-1",
      enabled: true,
    });
  });

  test("is null for a record that belongs to another Clerk org", () => {
    reads.organization = { clerkId: "org_2previous", name: "Previous Org" };

    expect(read(CLERK_ORG_ID)).toBeNull();
  });

  test("is null and reads nothing without an active Clerk org", () => {
    expect(read(null)).toBeNull();
    expect(reads.currentUserEnabled).toEqual([false]);
    expect(reads.organizationCalls.every(({ enabled }) => !enabled)).toBe(true);
  });

  test("waits for the current user before reading the org", () => {
    reads.currentUser = undefined;
    reads.organization = undefined;

    expect(read(CLERK_ORG_ID)).toBeNull();
    expect(reads.organizationCalls).toEqual([{ id: "", enabled: false }]);
  });
});
