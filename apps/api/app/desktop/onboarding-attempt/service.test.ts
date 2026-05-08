/**
 * Unit tests for desktopOnboardingAttemptsService.
 *
 * Covers fixed TTL persistence, lookups, and single-use consumption semantics.
 */
import { type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const withDb = Object.assign(vi.fn(), {
    tx: vi.fn(),
  });

  return { withDb };
});

vi.mock("@repo/database", () => ({
  ApiKeySource: { DESKTOP_MANAGED: "DESKTOP_MANAGED" },
  withDb: mocks.withDb,
}));

import {
  DesktopProvisioningAttemptStatus,
  DesktopProvisioningReadinessStatus,
} from "@repo/api/src/types/electron";
import { withDb } from "@repo/database";
import {
  DESKTOP_ONBOARDING_ATTEMPT_TTL_MS,
  desktopOnboardingAttemptsService,
} from "./service";

const mockWithDb = withDb as unknown as Mock & { tx: Mock };

describe("desktopOnboardingAttemptsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a new onboarding attempt with a 60 minute TTL", async () => {
    let createData: Record<string, unknown> | undefined;
    const before = Date.now();

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        desktopOnboardingAttempt: {
          create: vi.fn((args: { data: Record<string, unknown> }) => {
            createData = args.data;
            return Promise.resolve(args.data);
          }),
        },
      };
      return callback(mockDb);
    });

    const result = await desktopOnboardingAttemptsService.create({
      organizationId: "org-1",
      userId: "user-1",
      webAppOrigin: "https://app.closedloop.ai",
    });

    expect(result.onboardingAttemptId.length).toBeGreaterThan(20);
    expect(createData?.webAppOrigin).toBe("https://app.closedloop.ai");
    expect(createData?.consumedAt).toBeNull();
    expect(createData?.attemptId).toBe(result.onboardingAttemptId);

    const ttlMs = result.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(
      DESKTOP_ONBOARDING_ATTEMPT_TTL_MS - 1000
    );
    expect(ttlMs).toBeLessThanOrEqual(DESKTOP_ONBOARDING_ATTEMPT_TTL_MS + 1000);
  });

  it("loads a persisted onboarding attempt by attempt id", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        desktopOnboardingAttempt: {
          findUnique: vi.fn().mockResolvedValue({ attemptId: "attempt-123" }),
        },
      };
      return callback(mockDb);
    });

    await expect(
      desktopOnboardingAttemptsService.get("attempt-123")
    ).resolves.toEqual({ attemptId: "attempt-123" });
  });

  it("consumes an onboarding attempt exactly once while it is still unexpired", async () => {
    let updateArgs: Record<string, unknown> | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        desktopOnboardingAttempt: {
          updateMany: vi.fn((args: Record<string, unknown>) => {
            updateArgs = args;
            return Promise.resolve({ count: 1 });
          }),
        },
      };
      return callback(mockDb);
    });

    await expect(
      desktopOnboardingAttemptsService.consume("attempt-123", {
        gatewayId: "gateway-1",
      })
    ).resolves.toBe(true);

    expect(updateArgs).toMatchObject({
      where: {
        attemptId: "attempt-123",
        consumedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { consumedAt: expect.any(Date), gatewayId: "gateway-1" },
    });
  });

  it("reports complete status when a consumed attempt has an online protected target", async () => {
    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          desktopOnboardingAttempt: {
            findFirst: vi.fn().mockResolvedValue({
              attemptId: "attempt-123",
              organizationId: "org-1",
              userId: "user-1",
              webAppOrigin: "https://app.closedloop.ai",
              expiresAt: new Date(Date.now() + 60_000),
              consumedAt: new Date(),
              gatewayId: "gateway-1",
              computeTargetId: null,
            }),
          },
        };
        return callback(mockDb);
      })
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          computeTarget: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: "target-1", gatewayId: "gateway-1" }),
          },
          apiKey: {
            findMany: vi.fn().mockResolvedValue([{ gatewayId: "gateway-1" }]),
          },
        };
        return callback(mockDb);
      });

    await expect(
      desktopOnboardingAttemptsService.getStatus(
        "attempt-123",
        "org-1",
        "user-1"
      )
    ).resolves.toMatchObject({
      onboardingAttemptId: "attempt-123",
      status: DesktopProvisioningAttemptStatus.Complete,
      gatewayId: "gateway-1",
      computeTargetId: "target-1",
    });
  });

  it("reports complete status for a claimed attempt after the claim TTL expires", async () => {
    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          desktopOnboardingAttempt: {
            findFirst: vi.fn().mockResolvedValue({
              attemptId: "attempt-123",
              organizationId: "org-1",
              userId: "user-1",
              webAppOrigin: "https://app.closedloop.ai",
              expiresAt: new Date(Date.now() - 60_000),
              consumedAt: new Date(Date.now() - 30_000),
              gatewayId: "gateway-1",
              computeTargetId: null,
            }),
          },
        };
        return callback(mockDb);
      })
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          computeTarget: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: "target-1", gatewayId: "gateway-1" }),
          },
          apiKey: {
            findMany: vi.fn().mockResolvedValue([{ gatewayId: "gateway-1" }]),
          },
        };
        return callback(mockDb);
      });

    await expect(
      desktopOnboardingAttemptsService.getStatus(
        "attempt-123",
        "org-1",
        "user-1"
      )
    ).resolves.toMatchObject({
      onboardingAttemptId: "attempt-123",
      status: DesktopProvisioningAttemptStatus.Complete,
      gatewayId: "gateway-1",
      computeTargetId: "target-1",
    });
  });

  it("reports expired status for a claimed attempt after the TTL when no target is ready", async () => {
    const currentTime = new Date("2026-04-27T18:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(currentTime);

    try {
      mockWithDb
        .mockImplementationOnce((callback: (db: unknown) => unknown) => {
          const mockDb = {
            desktopOnboardingAttempt: {
              findFirst: vi.fn().mockResolvedValue({
                attemptId: "attempt-123",
                organizationId: "org-1",
                userId: "user-1",
                webAppOrigin: "https://app.closedloop.ai",
                expiresAt: new Date(currentTime.getTime() - 1000),
                consumedAt: new Date(currentTime.getTime() - 30_000),
                gatewayId: "gateway-1",
                computeTargetId: null,
              }),
            },
          };
          return callback(mockDb);
        })
        .mockImplementationOnce((callback: (db: unknown) => unknown) => {
          const mockDb = {
            computeTarget: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
            apiKey: {
              findMany: vi.fn().mockResolvedValue([{ gatewayId: "gateway-1" }]),
            },
          };
          return callback(mockDb);
        });

      await expect(
        desktopOnboardingAttemptsService.getStatus(
          "attempt-123",
          "org-1",
          "user-1"
        )
      ).resolves.toMatchObject({
        onboardingAttemptId: "attempt-123",
        status: DesktopProvisioningAttemptStatus.Expired,
        gatewayId: "gateway-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports null status when an attempt is not owned by the user", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        desktopOnboardingAttempt: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      return callback(mockDb);
    });

    await expect(
      desktopOnboardingAttemptsService.getStatus(
        "attempt-123",
        "org-1",
        "user-1"
      )
    ).resolves.toBeNull();
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("reports expired status without probing readiness", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        desktopOnboardingAttempt: {
          findFirst: vi.fn().mockResolvedValue({
            attemptId: "attempt-123",
            organizationId: "org-1",
            userId: "user-1",
            webAppOrigin: "https://app.closedloop.ai",
            expiresAt: new Date(Date.now() - 60_000),
            consumedAt: null,
            gatewayId: null,
            computeTargetId: null,
          }),
        },
      };
      return callback(mockDb);
    });

    await expect(
      desktopOnboardingAttemptsService.getStatus(
        "attempt-123",
        "org-1",
        "user-1"
      )
    ).resolves.toMatchObject({
      status: DesktopProvisioningAttemptStatus.Expired,
    });
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("reports pending status until the attempt is consumed with a gateway id", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        desktopOnboardingAttempt: {
          findFirst: vi.fn().mockResolvedValue({
            attemptId: "attempt-123",
            organizationId: "org-1",
            userId: "user-1",
            webAppOrigin: "https://app.closedloop.ai",
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt: null,
            gatewayId: null,
            computeTargetId: null,
          }),
        },
      };
      return callback(mockDb);
    });

    await expect(
      desktopOnboardingAttemptsService.getStatus(
        "attempt-123",
        "org-1",
        "user-1"
      )
    ).resolves.toMatchObject({
      status: DesktopProvisioningAttemptStatus.Pending,
    });
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("reports claimed status when a consumed attempt has not reached protected online readiness", async () => {
    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          desktopOnboardingAttempt: {
            findFirst: vi.fn().mockResolvedValue({
              attemptId: "attempt-123",
              organizationId: "org-1",
              userId: "user-1",
              webAppOrigin: "https://app.closedloop.ai",
              expiresAt: new Date(Date.now() + 60_000),
              consumedAt: new Date(),
              gatewayId: "gateway-1",
              computeTargetId: null,
            }),
          },
        };
        return callback(mockDb);
      })
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          computeTarget: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
          apiKey: {
            findMany: vi.fn().mockResolvedValue([{ gatewayId: "gateway-1" }]),
          },
        };
        return callback(mockDb);
      });

    await expect(
      desktopOnboardingAttemptsService.getStatus(
        "attempt-123",
        "org-1",
        "user-1"
      )
    ).resolves.toMatchObject({
      status: DesktopProvisioningAttemptStatus.Claimed,
      gatewayId: "gateway-1",
    });
  });

  it("reports complete readiness for any online protected Desktop target", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        computeTarget: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ id: "target-1", gatewayId: "gateway-1" }),
        },
        apiKey: {
          findMany: vi.fn().mockResolvedValue([{ gatewayId: "gateway-1" }]),
        },
      };
      return callback(mockDb);
    });

    await expect(
      desktopOnboardingAttemptsService.getReadiness("org-1", "user-1")
    ).resolves.toEqual({
      status: DesktopProvisioningReadinessStatus.Complete,
      gatewayId: "gateway-1",
      computeTargetId: "target-1",
    });
  });

  it("reports incomplete readiness when no protected gateway is online", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        computeTarget: {
          findFirst: vi.fn(),
        },
        apiKey: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      return callback(mockDb);
    });

    await expect(
      desktopOnboardingAttemptsService.getReadiness("org-1", "user-1")
    ).resolves.toEqual({
      status: DesktopProvisioningReadinessStatus.Incomplete,
    });
  });
});
