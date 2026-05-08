import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockDeleteMany = vi.fn();
  const mockCreate = vi.fn();
  const txClient = {
    localGatewayChallengeJti: {
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
      create: (...args: unknown[]) => mockCreate(...args),
    },
  };
  const withDb = Object.assign(
    vi.fn((fn: (db: typeof txClient) => unknown) => fn(txClient)),
    {
      tx: vi.fn((fn: (db: typeof txClient) => unknown) => fn(txClient)),
    }
  );

  return { mockCreate, mockDeleteMany, withDb };
});

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import {
  consumeJti,
  registerJti,
  resetLocalGatewayJtiRegistryForTests,
} from "../local-gateway-jti-registry";

describe("local-gateway-jti-registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockDeleteMany.mockResolvedValue({ count: 0 });
    mocks.mockCreate.mockResolvedValue(undefined);
  });

  it("consumes a registered jti only once", async () => {
    const expiresAt = new Date("2026-03-13T12:01:00.000Z");
    mocks.mockDeleteMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    await registerJti("jti-123", expiresAt);
    await expect(consumeJti("jti-123")).resolves.toBe(true);
    await expect(consumeJti("jti-123")).resolves.toBe(false);

    expect(mocks.mockCreate).toHaveBeenCalledWith({
      data: { jti: "jti-123", expiresAt },
    });
  });

  it("clears all JTIs in the test reset helper", async () => {
    await resetLocalGatewayJtiRegistryForTests();

    expect(mocks.withDb).toHaveBeenCalledTimes(1);
    expect(mocks.mockDeleteMany).toHaveBeenCalledWith();
  });
});
