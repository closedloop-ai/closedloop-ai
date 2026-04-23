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
  withDb: mocks.withDb,
}));

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
      desktopOnboardingAttemptsService.consume("attempt-123")
    ).resolves.toBe(true);

    expect(updateArgs).toMatchObject({
      where: {
        attemptId: "attempt-123",
        consumedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { consumedAt: expect.any(Date) },
    });
  });
});
