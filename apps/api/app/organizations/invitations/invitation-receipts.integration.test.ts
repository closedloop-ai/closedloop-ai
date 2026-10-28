import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import type { AuthContext } from "@/lib/auth/with-auth";

const clerk = vi.hoisted(() => ({
  createOrganizationInvitation: vi.fn(),
}));

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);
// Clerk is the system of record for the invitation and for the caller's role;
// these cases are about the receipt that follows a send.
vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    createOrganizationInvitation: clerk.createOrganizationInvitation,
  },
}));
vi.mock("@/lib/auth/settings-command", () => ({
  requireSettingsCommand: async () => null,
}));

import { POST as invite } from "@/app/organizations/invitations/route";

const harness = createReceiptRouteHarness();
const INVITATIONS_ROUTE = "/organizations/invitations";
const NO_PARAMS = receiptRouteParams({});
const INVITE_BODY = { emailAddresses: ["teammate@example.com"] };

/**
 * ISS-12552: an API-key invitation send that
 * invited someone records one fail-open organization receipt after the Clerk
 * calls.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 invitation receipts", () => {
  beforeEach(() => {
    clerk.createOrganizationInvitation.mockReset();
    clerk.createOrganizationInvitation.mockResolvedValue({ id: "inv_1" });
  });
  afterEach(() => harness.cleanup());

  it("records one organization receipt when the batch invited someone", async () => {
    const world = await harness.seedWorld();

    const response = await send();

    expect(response.status).toBe(200);
    expect(await readReceipts(world.organizationId)).toEqual([
      {
        operationKind: OperationKind.OrganizationWrite,
        outcome: OperationReceiptOutcome.Committed,
        source: OperationSource.Api,
        targetArtifactId: null,
        createdArtifactId: null,
        changedFields: [],
        route: INVITATIONS_ROUTE,
      },
    ]);
  });

  it("records none when the batch invited nobody", async () => {
    const world = await harness.seedWorld();
    clerk.createOrganizationInvitation.mockRejectedValue({
      errors: [{ code: "duplicate_record" }],
    });

    const response = await send();

    expect(response.status).toBe(200);
    expect((await response.json()).data.invited).toBe(0);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("still answers success when the receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    failReceiptInserts();

    const response = await send();

    expect(response.status).toBe(200);
    expect((await response.json()).data.invited).toBe(1);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("records none with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    turnAttributionFlagOff();

    const response = await send();

    expect(response.status).toBe(200);
    expect(clerk.createOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("records none for a signed-in session caller", async () => {
    const world = await harness.seedWorld();
    receiptRouteState.context = {
      ...(receiptRouteState.context as AuthContext),
      authMethod: "session",
    };

    const response = await send();

    expect(response.status).toBe(200);
    expect(clerk.createOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });
});

function send() {
  return invite(
    apiKeyRouteRequest("POST", INVITATIONS_ROUTE, INVITE_BODY),
    NO_PARAMS
  );
}
