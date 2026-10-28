import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);

import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import {
  isAttributionEvidenceEnabledForOrganization,
  isAttributionEvidenceReadOffForOrganization,
  isAttributionEvidenceReadOnForOrganization,
  readAttributionEvidenceForRequest,
} from "@/lib/attribution-evidence-policy-feature";

const ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000aa";

/**
 * ISS-12552: the flag mock the receipt route suites share replaces only the
 * organization's evaluation. The answer it gives still goes through the real
 * request scope, so a writer inside a transaction that reads the memo alone
 * sees the answer the request read before its transaction opened.
 */
describe("receiptRouteFlagMock", () => {
  afterEach(() => {
    receiptRouteState.attributionFlagOn = true;
    receiptRouteState.attributionFlagEvaluations = 0;
  });

  it("hands the in-transaction readers the on answer the request read", async () => {
    const held = await runWithAttributionEvidenceGate(async () => {
      await readAttributionEvidenceForRequest(ORGANIZATION_ID);
      return {
        on: isAttributionEvidenceReadOnForOrganization(ORGANIZATION_ID),
        off: isAttributionEvidenceReadOffForOrganization(ORGANIZATION_ID),
      };
    });

    expect(held).toEqual({ on: true, off: false });
  });

  it("hands them the off answer once a case turns the flag off", async () => {
    receiptRouteState.attributionFlagOn = false;

    const held = await runWithAttributionEvidenceGate(async () => {
      await readAttributionEvidenceForRequest(ORGANIZATION_ID);
      return {
        on: isAttributionEvidenceReadOnForOrganization(ORGANIZATION_ID),
        off: isAttributionEvidenceReadOffForOrganization(ORGANIZATION_ID),
      };
    });

    expect(held).toEqual({ on: false, off: true });
  });

  it("evaluates an organization once per request, as the real gate does", async () => {
    const answers = await runWithAttributionEvidenceGate(async () => [
      await isAttributionEvidenceEnabledForOrganization(ORGANIZATION_ID),
      await isAttributionEvidenceEnabledForOrganization(ORGANIZATION_ID),
    ]);

    expect(answers).toEqual([true, true]);
    expect(receiptRouteState.attributionFlagEvaluations).toBe(1);
  });
});
