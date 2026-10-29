/**
 * ISS-8661 — the custom-field admin gates admit both privileged roles, refuse a
 * member with 403, and answer 503 when the role could not be read.
 *
 * These five routes had no admin-gate test of any kind before this change, so
 * the whole `requireOrgAdmin` family they now share was unpinned at the route
 * layer. The Clerk client is stubbed and the REAL `org-admin` module runs behind
 * each REAL handler: stubbing the gate cannot exercise the split, because the
 * throw has to originate at the provider call.
 *
 * Roles come from `ClerkOrgRoleFixture`, the suites' hand-written oracle for
 * Clerk's wire values — never from `OrgAdminRole`, which is the set under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

const mocks = vi.hoisted(() => ({
  getOrganizationMembershipRole: vi.fn(),
  customFieldsService: { createField: vi.fn(), findById: vi.fn() },
  customFieldEnumOptionsService: { createOption: vi.fn() },
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("../service", () => ({
  customFieldsService: mocks.customFieldsService,
  DuplicateNameError: class DuplicateNameError extends Error {},
}));

import { CustomFieldType } from "@repo/api/src/types/custom-field";
import {
  ClerkOrgRoleFixture,
  createMockRequest,
  createTestAuthContext,
  PRIVILEGED_CLERK_ORG_ROLES,
} from "@/__tests__/utils/auth-helpers";
import { OrgAdminGateErrorCode } from "@/lib/auth/org-admin-denial";
import { POST as createCustomField } from "../route";

mockAuthContext = createTestAuthContext({
  clerkOrgId: "clerk-org-custom-fields",
  clerkUserId: "clerk-user-custom-fields",
});

const VALID_BODY = {
  name: "Severity",
  fieldType: CustomFieldType.Text,
};

function invoke() {
  return createCustomField(
    createMockRequest({
      method: "POST",
      url: "https://api.example.test/custom-fields",
      body: VALID_BODY,
    }),
    { params: Promise.resolve({}) }
  );
}

describe("POST /custom-fields — org-admin gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.customFieldsService.createField.mockResolvedValue({
      id: "field-1",
      name: VALID_BODY.name,
      options: [],
    });
  });

  it.each(PRIVILEGED_CLERK_ORG_ROLES)(
    "admits the %s role and creates the field",
    async (role) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(role);

      const response = await invoke();

      expect(response.status).toBe(200);
      expect(mocks.customFieldsService.createField).toHaveBeenCalled();
    }
  );

  // Proves the stubbed role actually drives the gate — without it, a handler
  // that answered 200 unconditionally would pass both cases above.
  it("refuses an unprivileged role with 403 and creates nothing", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    const response = await invoke();

    expect(response.status).toBe(403);
    expect(mocks.customFieldsService.createField).not.toHaveBeenCalled();
  });

  it("answers 503 role_unresolved, never 403, when Clerk throws", async () => {
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("clerk unreachable")
    );

    const response = await invoke();

    expect(response.status).toBe(503);
    expect(response.status).not.toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: OrgAdminGateErrorCode.RoleUnresolved,
    });
    // Fail CLOSED: an unresolvable role never creates a field.
    expect(mocks.customFieldsService.createField).not.toHaveBeenCalled();
  });
});
