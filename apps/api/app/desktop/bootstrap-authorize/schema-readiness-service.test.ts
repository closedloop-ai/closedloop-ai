import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@repo/database", () => ({
  withDb: (callback: (db: unknown) => Promise<unknown>) =>
    callback({ desktopBootstrapCode: { findFirst: mocks.findFirst } }),
}));

import { desktopBootstrapSchemaReadinessService } from "./schema-readiness-service";

describe("bootstrap schema readiness", () => {
  beforeEach(() => vi.resetAllMocks());

  it("probes all required columns even when there are no bootstrap rows", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(
      desktopBootstrapSchemaReadinessService.isReady()
    ).resolves.toBe(true);
    expect(mocks.findFirst).toHaveBeenCalledExactlyOnceWith({
      select: {
        consumedAt: true,
        organizationClerkId: true,
        completedAt: true,
      },
    });
  });

  it.each(["consumedAt", "organizationClerkId", "completedAt"])(
    "refuses a missing %s and recovers on the next request without restarting",
    async (missingColumn) => {
      mocks.findFirst.mockImplementationOnce(({ select }) => {
        if (select[missingColumn]) {
          throw new Error("column does not exist");
        }
        return null;
      });
      await expect(
        desktopBootstrapSchemaReadinessService.isReady()
      ).resolves.toBe(false);
      mocks.findFirst.mockResolvedValue(null);
      await expect(
        desktopBootstrapSchemaReadinessService.isReady()
      ).resolves.toBe(true);
      expect(mocks.findFirst).toHaveBeenCalledTimes(2);
    }
  );

  it("does not retain readiness across database faults", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      desktopBootstrapSchemaReadinessService.isReady()
    ).resolves.toBe(true);
    await expect(
      desktopBootstrapSchemaReadinessService.isReady()
    ).resolves.toBe(false);
  });
});
