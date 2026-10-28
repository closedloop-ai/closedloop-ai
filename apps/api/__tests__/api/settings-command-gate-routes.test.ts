/**
 * ISS-8716 — every MIGRATED Settings mutation boundary refuses through the REAL
 * `authorizeSettingsCommand`. Migrated, not every admin-gated write in
 * `apps/api`: `settings-command.ts` enumerates both the ten wired here and
 * the ones deliberately left on `getOrgAdminStatus`.
 *
 * ISS-8378 landed the guard with no production caller: deleting it changed no
 * enforcement and its suite stayed green. This file is what makes it
 * load-bearing. The Clerk client is stubbed and the REAL gate runs behind each
 * REAL handler — stubbing `requireSettingsCommand` itself would prove only that
 * a mock returns what it was told to.
 *
 * THE EXPECTED POLICY IS PINNED WITH INDEPENDENT LITERALS, deliberately. No
 * case reads `SETTINGS_DOMAIN_ACCESS_POLICY`, because a fixture that imports
 * the table it polices cannot fail when that table is widened. Roles likewise
 * come from `ClerkOrgRoleFixture`, the suites' hand-written oracle for Clerk's
 * wire values.
 *
 * Each row asserts the GATED EFFECT, not just the status: a 403 whose write
 * still reached the service would pass a status-only assertion, and the
 * admitted case is what proves the stubbed role genuinely drives the outcome
 * rather than the handler refusing everyone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

const mocks = vi.hoisted(() => ({
  getOrganizationMembershipRole: vi.fn(),
  frustrationSettingService: {
    isFrustrationEnabled: vi.fn(),
    setFrustrationEnabled: vi.fn(),
  },
  penseroService: {
    getOrgCredentialInfo: vi.fn(),
    setOrgCredential: vi.fn(),
    removeOrgCredential: vi.fn(),
  },
  isPenseroRolloutEnabled: vi.fn(),
  organizationsService: { findById: vi.fn() },
  invitationsService: { inviteMembers: vi.fn() },
  customFieldsService: {
    createField: vi.fn(),
    updateField: vi.fn(),
    findById: vi.fn(),
    deleteField: vi.fn(),
  },
  enumOptionsService: {
    createEnumOption: vi.fn(),
    updateEnumOption: vi.fn(),
    reorderEnumOptions: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
  // Not reached today — no case here drives a Clerk failure. Present so the day
  // one does, it fails on the assertion it came for rather than on a missing
  // mock export, which Vitest only rejects at property access.
  isClerkNotFound: () => false,
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

vi.mock("@/app/settings/frustration-setting-service", () => ({
  frustrationSettingService: mocks.frustrationSettingService,
}));

vi.mock("@/app/settings/pensero-integration-service", () => ({
  penseroIntegrationService: mocks.penseroService,
}));

vi.mock("@/app/settings/pensero/pensero-rollout-feature", async (original) => ({
  ...(await original<
    typeof import("@/app/settings/pensero/pensero-rollout-feature")
  >()),
  isPenseroIntegrationRolloutEnabled: mocks.isPenseroRolloutEnabled,
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: mocks.organizationsService,
}));

vi.mock("@/app/organizations/invitations/service", () => ({
  invitationsService: mocks.invitationsService,
}));

vi.mock("@/app/custom-fields/service", () => ({
  customFieldsService: mocks.customFieldsService,
  DuplicateNameError: class DuplicateNameError extends Error {},
  IncompatibleNumberFormatError: class IncompatibleNumberFormatError extends Error {},
  IncompatibleReferenceSourcesError: class IncompatibleReferenceSourcesError extends Error {},
}));

vi.mock("@/app/custom-fields/enum-options-service", () => ({
  enumOptionsService: mocks.enumOptionsService,
}));

import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { PENSERO_INTEGRATION_PATH } from "@repo/api/src/types/pensero-integration";
import { ADMIN_GATE_REQUESTS } from "@/__tests__/support/auth/admin-gate-routes.test-fixtures";
import {
  ClerkOrgRoleFixture,
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
  PRIVILEGED_CLERK_ORG_ROLES,
} from "@/__tests__/utils/auth-helpers";
import { PUT as updateEnumOption } from "@/app/custom-fields/[id]/enum-options/[optionId]/route";
import { POST as reorderEnumOptions } from "@/app/custom-fields/[id]/enum-options/reorder/route";
import { POST as createEnumOption } from "@/app/custom-fields/[id]/enum-options/route";
import {
  DELETE as deleteCustomField,
  PUT as updateCustomField,
} from "@/app/custom-fields/[id]/route";
import { POST as createCustomField } from "@/app/custom-fields/route";
import { POST as inviteMembers } from "@/app/organizations/invitations/route";
import { PUT as putFrustration } from "@/app/settings/frustration/route";
import {
  DELETE as deletePensero,
  PUT as putPensero,
} from "@/app/settings/pensero/route";
import { OrgAdminGateErrorCode } from "@/lib/auth/org-admin-denial";

const CLERK_ORG_ID = "clerk-org-settings-command";
const CLERK_USER_ID = "clerk-user-settings-command";
const FIELD_ID = "0b6f6b3c-6d5f-4f2b-9f0a-2f5a3d2f4c11";
const OPTION_ID = "5c1d3f8e-9a2b-4c6d-8e1f-7a3b5c9d2e44";

mockAuthContext = createTestAuthContext({
  clerkOrgId: CLERK_ORG_ID,
  clerkUserId: CLERK_USER_ID,
});

/**
 * Every Settings mutation boundary ISS-8716 wired, with the privileged work it
 * guards. `gatedEffect` is the falsifier: without it a handler that answered
 * 403 while still writing would satisfy the status assertions.
 */
const wiredBoundaries: {
  name: string;
  invoke: () => Promise<Response>;
  gatedEffect: () => ReturnType<typeof vi.fn>;
}[] = [
  {
    name: "PUT /settings/frustration",
    invoke: () =>
      putFrustration(
        createMockRequest(ADMIN_GATE_REQUESTS.frustration),
        createMockRouteContext({})
      ),
    gatedEffect: () => mocks.frustrationSettingService.setFrustrationEnabled,
  },
  {
    name: `PUT ${PENSERO_INTEGRATION_PATH}`,
    invoke: () =>
      putPensero(
        createMockRequest({
          url: `https://api.example.test${PENSERO_INTEGRATION_PATH}`,
          method: "PUT",
          body: { token: "tk_public:sk_secret9876" },
        }),
        createMockRouteContext({})
      ),
    gatedEffect: () => mocks.penseroService.setOrgCredential,
  },
  {
    name: `DELETE ${PENSERO_INTEGRATION_PATH}`,
    invoke: () =>
      deletePensero(
        createMockRequest({
          url: `https://api.example.test${PENSERO_INTEGRATION_PATH}`,
          method: "DELETE",
        }),
        createMockRouteContext({})
      ),
    gatedEffect: () => mocks.penseroService.removeOrgCredential,
  },
  {
    name: "POST /organizations/invitations",
    invoke: () =>
      inviteMembers(
        createMockRequest({
          url: "https://api.example.test/organizations/invitations",
          method: "POST",
          body: { emailAddresses: ["invitee@example.test"] },
        }),
        createMockRouteContext({})
      ),
    gatedEffect: () => mocks.invitationsService.inviteMembers,
  },
  {
    name: "POST /custom-fields",
    invoke: () =>
      createCustomField(
        createMockRequest({
          url: "https://api.example.test/custom-fields",
          method: "POST",
          body: { name: "Severity", fieldType: CustomFieldType.Text },
        }),
        createMockRouteContext({})
      ),
    gatedEffect: () => mocks.customFieldsService.createField,
  },
  {
    name: "PUT /custom-fields/[id]",
    invoke: () =>
      updateCustomField(
        createMockRequest({
          url: `https://api.example.test/custom-fields/${FIELD_ID}`,
          method: "PUT",
          body: { name: "Renamed" },
        }),
        createMockRouteContext({ id: FIELD_ID })
      ),
    gatedEffect: () => mocks.customFieldsService.updateField,
  },
  {
    name: "DELETE /custom-fields/[id]",
    invoke: () =>
      deleteCustomField(
        createMockRequest({
          url: `https://api.example.test/custom-fields/${FIELD_ID}`,
          method: "DELETE",
        }),
        createMockRouteContext({ id: FIELD_ID })
      ),
    gatedEffect: () => mocks.customFieldsService.deleteField,
  },
  {
    name: "POST /custom-fields/[id]/enum-options",
    invoke: () =>
      createEnumOption(
        createMockRequest({
          url: `https://api.example.test/custom-fields/${FIELD_ID}/enum-options`,
          method: "POST",
          body: { name: "High" },
        }),
        createMockRouteContext({ id: FIELD_ID })
      ),
    gatedEffect: () => mocks.enumOptionsService.createEnumOption,
  },
  {
    name: "PUT /custom-fields/[id]/enum-options/[optionId]",
    invoke: () =>
      updateEnumOption(
        createMockRequest({
          url: `https://api.example.test/custom-fields/${FIELD_ID}/enum-options/${OPTION_ID}`,
          method: "PUT",
          body: { name: "Higher" },
        }),
        createMockRouteContext({ id: FIELD_ID, optionId: OPTION_ID })
      ),
    gatedEffect: () => mocks.enumOptionsService.updateEnumOption,
  },
  {
    name: "POST /custom-fields/[id]/enum-options/reorder",
    invoke: () =>
      reorderEnumOptions(
        createMockRequest({
          url: `https://api.example.test/custom-fields/${FIELD_ID}/enum-options/reorder`,
          method: "POST",
          body: { optionIds: [OPTION_ID] },
        }),
        createMockRouteContext({ id: FIELD_ID })
      ),
    gatedEffect: () => mocks.enumOptionsService.reorderEnumOptions,
  },
];

function armDownstreamServices(): void {
  mocks.frustrationSettingService.setFrustrationEnabled.mockResolvedValue(
    undefined
  );
  mocks.isPenseroRolloutEnabled.mockResolvedValue(true);
  mocks.penseroService.setOrgCredential.mockResolvedValue({
    isSet: true,
    lastFour: "9876",
    baseUrl: null,
    setAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  mocks.penseroService.removeOrgCredential.mockResolvedValue(undefined);
  mocks.organizationsService.findById.mockResolvedValue({
    id: "test-org-id",
    clerkId: CLERK_ORG_ID,
  });
  mocks.invitationsService.inviteMembers.mockResolvedValue({
    invited: 1,
    results: [],
  });
  mocks.customFieldsService.createField.mockResolvedValue({
    id: FIELD_ID,
    options: [],
  });
  mocks.customFieldsService.updateField.mockResolvedValue({
    id: FIELD_ID,
    options: [],
  });
  mocks.customFieldsService.findById.mockResolvedValue({ id: FIELD_ID });
  mocks.customFieldsService.deleteField.mockResolvedValue(undefined);
  mocks.enumOptionsService.createEnumOption.mockResolvedValue({
    id: OPTION_ID,
  });
  mocks.enumOptionsService.updateEnumOption.mockResolvedValue({
    id: OPTION_ID,
  });
  mocks.enumOptionsService.reorderEnumOptions.mockResolvedValue(undefined);
}

describe("Settings mutation boundaries run the real authorizeSettingsCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armDownstreamServices();
  });

  it.each(wiredBoundaries)(
    "$name refuses a plain member with 403 and performs no write",
    async ({ invoke, gatedEffect }) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(
        ClerkOrgRoleFixture.Member
      );

      const response = await invoke();

      expect(response.status).toBe(403);
      expect(gatedEffect()).not.toHaveBeenCalled();
    }
  );

  it.each(wiredBoundaries)(
    "$name answers 503 role_unresolved, never 403, when the role cannot be read",
    async ({ invoke, gatedEffect }) => {
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
      // Fail CLOSED: an undecidable role still writes nothing.
      expect(gatedEffect()).not.toHaveBeenCalled();
    }
  );

  it.each(wiredBoundaries)(
    "$name refuses a caller with no membership at all",
    async ({ invoke, gatedEffect }) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(null);

      const response = await invoke();

      expect(response.status).toBe(403);
      expect(gatedEffect()).not.toHaveBeenCalled();
    }
  );

  // A membership row whose role is blank is corrupt provider data, not the
  // settled "no membership" answer. Reporting it as a denial would tell a real
  // admin they had been removed from their organization.
  it.each(wiredBoundaries)(
    "$name answers 503 for a present-but-unusable role",
    async ({ invoke, gatedEffect }) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue("   ");

      const response = await invoke();

      expect(response.status).toBe(503);
      expect(gatedEffect()).not.toHaveBeenCalled();
    }
  );

  // Without these the whole suite would pass against a gate that refused
  // everyone, which is the failure mode a refusal-only file cannot see.
  it.each(
    wiredBoundaries.flatMap((boundary) =>
      PRIVILEGED_CLERK_ORG_ROLES.map((role) => ({ ...boundary, role }))
    )
  )(
    "$name admits the $role role and performs the write",
    async ({ invoke, gatedEffect, role }) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(role);

      const response = await invoke();

      expect(response.status).not.toBe(403);
      expect(response.status).not.toBe(503);
      expect(gatedEffect()).toHaveBeenCalled();
    }
  );
});
