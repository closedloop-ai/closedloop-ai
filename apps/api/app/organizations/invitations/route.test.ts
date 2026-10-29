import { InviteMemberStatus } from "@repo/api/src/types/onboarding";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    authMethod: "session",
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: {
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
    },
  },
  logError: vi.fn(),
  organizationsService: {
    findById: vi.fn(),
  },
  invitationsService: {
    inviteMembers: vi.fn(),
  },
  requireSettingsCommand: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/lib/auth/settings-command", () => ({
  requireSettingsCommand: mocks.requireSettingsCommand,
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("../service", () => ({
  organizationsService: mocks.organizationsService,
}));

vi.mock("./service", () => ({
  invitationsService: mocks.invitationsService,
}));

import { SettingsCommandCapability } from "@repo/api/src/types/settings-command";
import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import {
  ORG_ADMIN_ADMITTED,
  orgAdminRefused,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import { POST } from "./route";

const ORG_ID = "org-1";
const CLERK_ORG_ID = "clerk-org-1";
/**
 * A Clerk org that is NOT the authenticated caller's. Fixtures that use it as
 * the organization ROW's `clerkId` split the two values the admin gate could
 * read apart, so a test can tell which one the decision actually used. A
 * fixture where both are `CLERK_ORG_ID` cannot: it passes whichever source the
 * gate reads.
 */
const FOREIGN_CLERK_ORG_ID = "clerk-org-2";
const BASE_ORGANIZATION = {
  active: true,
  clerkId: CLERK_ORG_ID,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  id: ORG_ID,
  name: "Acme",
  searchIncludeTranscripts: false,
  settings: {},
  slug: "acme",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/organizations/invitations", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /organizations/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organizationsService.findById.mockResolvedValue(BASE_ORGANIZATION);
    mocks.requireSettingsCommand.mockResolvedValue(ORG_ADMIN_ADMITTED);
    mocks.invitationsService.inviteMembers.mockResolvedValue({
      invited: 1,
      results: [
        {
          email: "a@example.com",
          invitationId: "inv_1",
          status: InviteMemberStatus.Invited,
        },
      ],
    });
  });

  it("mints invitations scoped to the caller's org when the caller is an admin", async () => {
    const response = await POST(
      makeRequest({ emailAddresses: ["a@example.com"] }),
      {
        params: Promise.resolve({}),
      }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.invited).toBe(1);
    // Org scoping: authorization is checked against the caller's own org.
    expect(mocks.requireSettingsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        clerkOrgId: CLERK_ORG_ID,
        clerkUserId: "clerk-user-1",
        domain: SettingsDomainId.Members,
        capability: SettingsCommandCapability.Admin,
      })
    );
    expect(mocks.invitationsService.inviteMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        // Both ids come off the authenticated session: the Clerk one scopes the
        // invitation, the local one scopes the onboarding marker the service
        // writes for it.
        organizationId: ORG_ID,
        clerkOrgId: CLERK_ORG_ID,
        inviterClerkUserId: "clerk-user-1",
        emailAddresses: ["a@example.com"],
      })
    );
  });

  it("returns 403 when the caller is not an org admin", async () => {
    mocks.requireSettingsCommand.mockImplementation(orgAdminRefused);

    const response = await POST(
      makeRequest({ emailAddresses: ["a@example.com"] }),
      {
        params: Promise.resolve({}),
      }
    );

    expect(response.status).toBe(403);
    expect(mocks.invitationsService.inviteMembers).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller's organization cannot be resolved", async () => {
    mocks.organizationsService.findById.mockResolvedValue(null);

    const response = await POST(
      makeRequest({ emailAddresses: ["a@example.com"] }),
      {
        params: Promise.resolve({}),
      }
    );

    expect(response.status).toBe(404);
    expect(mocks.requireSettingsCommand).not.toHaveBeenCalled();
  });

  it("rejects invalid input (non-email) with a 400 via Zod", async () => {
    const response = await POST(
      makeRequest({ emailAddresses: ["not-an-email"] }),
      {
        params: Promise.resolve({}),
      }
    );

    expect(response.status).toBe(400);
    expect(mocks.invitationsService.inviteMembers).not.toHaveBeenCalled();
  });

  it("rejects an empty email list with a 400", async () => {
    const response = await POST(makeRequest({ emailAddresses: [] }), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(400);
  });

  describe("when the organization row's clerkId is not the caller's org", () => {
    beforeEach(() => {
      mocks.organizationsService.findById.mockResolvedValue({
        ...BASE_ORGANIZATION,
        clerkId: FOREIGN_CLERK_ORG_ID,
      });
    });

    it("denies when the caller only administers the row's org", async () => {
      // Admin of the row's org, member of their own. Reading the row's clerkId
      // admits; reading the authenticated context denies.
      mocks.requireSettingsCommand.mockImplementation(
        ({ clerkOrgId }: { clerkOrgId: string }) =>
          Promise.resolve(
            clerkOrgId === FOREIGN_CLERK_ORG_ID
              ? ORG_ADMIN_ADMITTED
              : orgAdminRefused()
          )
      );

      const response = await POST(
        makeRequest({ emailAddresses: ["a@example.com"] }),
        { params: Promise.resolve({}) }
      );

      expect(response.status).toBe(403);
      expect(mocks.invitationsService.inviteMembers).not.toHaveBeenCalled();
    });

    it("invites into the caller's own org, never the row's", async () => {
      mocks.requireSettingsCommand.mockImplementation(
        ({ clerkOrgId }: { clerkOrgId: string }) =>
          Promise.resolve(
            clerkOrgId === CLERK_ORG_ID ? ORG_ADMIN_ADMITTED : orgAdminRefused()
          )
      );

      const response = await POST(
        makeRequest({ emailAddresses: ["a@example.com"] }),
        { params: Promise.resolve({}) }
      );

      expect(response.status).toBe(200);
      expect(mocks.invitationsService.inviteMembers).toHaveBeenCalledWith(
        expect.objectContaining({ clerkOrgId: CLERK_ORG_ID })
      );
    });
  });

  it("de-duplicates and normalizes emails before inviting", async () => {
    await POST(
      makeRequest({ emailAddresses: ["A@Example.com", "a@example.com"] }),
      { params: Promise.resolve({}) }
    );

    expect(mocks.invitationsService.inviteMembers).toHaveBeenCalledWith(
      expect.objectContaining({ emailAddresses: ["a@example.com"] })
    );
  });
});
