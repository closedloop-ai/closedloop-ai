/**
 * ISS-4905: the compute-target security projection must filter API keys with
 * the same usability predicate the verifier applies. Before this, any
 * non-revoked row rendered as "Protected", so a key `verifyKeyWithMetadata`
 * refuses still reported the gateway as protected and suppressed the upgrade
 * prompt that would have reprovisioned it.
 */

import { API_KEY_SCOPES } from "@repo/api/src/types/api-key";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: { DESKTOP_MANAGED: "DESKTOP_MANAGED" },
  withDb: mocks.withDb,
}));

import { loadProtectedGateways } from "../protected-gateways";

const findMany = vi.fn();

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  mocks.withDb.mockReset();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ apiKey: { findMany } })
  );
});

describe("loadProtectedGateways", () => {
  it("requires a usable scope set, not merely a non-revoked row", async () => {
    await loadProtectedGateways("org-1", "user-1", ["gateway-a"]);

    const { where } = findMany.mock.calls[0][0];
    expect(where.scopes).toEqual({ hasSome: [...API_KEY_SCOPES] });
    expect(where.revokedAt).toBeNull();
    expect(where.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
  });

  it("keeps the gateway, owner, and binding predicates alongside it", async () => {
    await loadProtectedGateways("org-1", "user-1", ["gateway-a", "gateway-b"]);

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      source: "DESKTOP_MANAGED",
      gatewayId: { in: ["gateway-a", "gateway-b"] },
      boundPublicKey: { not: null },
    });
  });

  it("reports the gateways whose keys matched", async () => {
    findMany.mockResolvedValue([
      { gatewayId: "gateway-a" },
      { gatewayId: null },
    ]);

    const result = await loadProtectedGateways("org-1", "user-1", [
      "gateway-a",
      "gateway-b",
    ]);

    expect(result).toEqual({
      protectedGateways: new Set(["gateway-a"]),
      lookupFailed: false,
    });
  });

  it("distinguishes a failed lookup from an unprotected gateway", async () => {
    findMany.mockRejectedValue(new Error("db unavailable"));

    expect(
      await loadProtectedGateways("org-1", "user-1", ["gateway-a"])
    ).toEqual({ protectedGateways: new Set(), lookupFailed: true });
  });

  it("skips the query entirely when no gateways were asked about", async () => {
    const result = await loadProtectedGateways("org-1", "user-1", []);

    expect(findMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      protectedGateways: new Set(),
      lookupFailed: false,
    });
  });
});
