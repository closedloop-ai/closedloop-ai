import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopDeviceSessionRecord } from "./service";

const mocks = vi.hoisted(() => ({
  desktopOnboardingAttemptsService: {
    create: vi.fn(),
  },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@/app/desktop/onboarding-attempt/service", () => ({
  desktopOnboardingAttemptsService: mocks.desktopOnboardingAttemptsService,
}));

import {
  DESKTOP_DEVICE_SESSION_RATE_LIMIT_MAX,
  desktopDeviceOnboardingService,
} from "./service";

const now = new Date("2026-04-28T17:00:00.000Z");
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function installDb(db: unknown) {
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
}

function buildSession(
  overrides: Partial<DesktopDeviceSessionRecord> = {}
): DesktopDeviceSessionRecord {
  return {
    id: "019dd545-9926-7447-99fe-2671bf53acb1",
    deviceSessionSecretHash: "hash",
    userCode: "ABCD1234",
    requestIpHash: null,
    webAppOrigin: "https://app.closedloop.ai",
    gatewayId: "019dd545-b11d-444d-9956-0310752e2481",
    gatewayPublicKeyPem:
      "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
    machineName: "Daniel-MBP",
    platform: "darwin",
    desktopVersion: "0.13.22",
    desktopSecurityUpgradeProtocolVersion: 1,
    status: "pending",
    userId: null,
    organizationId: null,
    onboardingAttemptId: null,
    deniedAt: null,
    approvedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const startInput = {
  webAppOrigin: "https://app.closedloop.ai",
  gatewayId: "019dd545-b11d-444d-9956-0310752e2481",
  gatewayPublicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
  machineName: "Daniel-MBP",
  platform: "darwin",
  desktopVersion: "0.13.22",
  desktopSecurityUpgradeProtocolVersion: 1 as const,
};

describe("desktopDeviceOnboardingService.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hashes the device secret and request IP while returning only the plaintext secret to Desktop", async () => {
    let createData: Record<string, unknown> | undefined;
    installDb({
      desktopOnboardingDeviceSession: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn((args: { data: Record<string, unknown> }) => {
          createData = args.data;
          return Promise.resolve({
            ...buildSession(),
            ...args.data,
            id: "019dd545-9926-7447-99fe-2671bf53acb1",
          });
        }),
      },
    });

    const result = await desktopDeviceOnboardingService.start({
      ...startInput,
      requestIp: "203.0.113.10",
    });

    expect(result.status).toBe("started");
    if (result.status !== "started") {
      throw new Error("expected started result");
    }
    expect(result.deviceSessionSecret).toEqual(expect.any(String));
    expect(createData?.deviceSessionSecretHash).toMatch(SHA256_HEX_RE);
    expect(createData?.deviceSessionSecretHash).not.toBe(
      result.deviceSessionSecret
    );
    expect(createData?.requestIpHash).toMatch(SHA256_HEX_RE);
    expect(createData?.requestIpHash).not.toBe("203.0.113.10");
    expect(result.verificationUrl).toContain(
      "https://app.closedloop.ai/settings/integrations/desktop/connect?code="
    );
  });

  it("rejects start when the pending gateway or request-IP rate limit is reached", async () => {
    const create = vi.fn();
    installDb({
      desktopOnboardingDeviceSession: {
        count: vi.fn().mockResolvedValue(DESKTOP_DEVICE_SESSION_RATE_LIMIT_MAX),
        create,
      },
    });

    await expect(
      desktopDeviceOnboardingService.start({
        ...startInput,
        requestIp: "203.0.113.10",
      })
    ).resolves.toEqual({ status: "rate_limited" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("desktopDeviceOnboardingService approval and poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.desktopOnboardingAttemptsService.create.mockResolvedValue({
      onboardingAttemptId: "attempt-1",
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("approves a pending session by creating a bound desktop-first attempt", async () => {
    let attemptInput: Record<string, unknown> | undefined;
    mocks.desktopOnboardingAttemptsService.create.mockImplementation(
      (input: Record<string, unknown>) => {
        attemptInput = input;
        return Promise.resolve({
          onboardingAttemptId: "attempt-1",
          expiresAt: new Date(Date.now() + 60_000),
        });
      }
    );
    installDb({
      desktopOnboardingDeviceSession: {
        findUnique: vi.fn().mockResolvedValue(buildSession()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(
            buildSession({
              status: "approved",
              userId: "user-1",
              organizationId: "org-1",
              approvedAt: now,
              ...(args.data as Partial<DesktopDeviceSessionRecord>),
            })
          )
        ),
      },
    });

    const row = await desktopDeviceOnboardingService.approve({
      userCode: "ABCD1234",
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(attemptInput).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      webAppOrigin: "https://app.closedloop.ai",
      flowType: "desktop_first_connect",
      gatewayId: "019dd545-b11d-444d-9956-0310752e2481",
    });
    expect(row?.status).toBe("approved");
    expect(row?.onboardingAttemptId).toBe("attempt-1");
  });

  it("returns null instead of approving denied or expired sessions", async () => {
    installDb({
      desktopOnboardingDeviceSession: {
        findUnique: vi.fn().mockResolvedValue(
          buildSession({
            status: "denied",
            expiresAt: new Date(now.getTime() - 60_000),
          })
        ),
        updateMany: vi.fn(),
      },
    });

    await expect(
      desktopDeviceOnboardingService.approve({
        userCode: "ABCD1234",
        userId: "user-1",
        organizationId: "org-1",
      })
    ).resolves.toBeNull();
    expect(
      mocks.desktopOnboardingAttemptsService.create
    ).not.toHaveBeenCalled();
  });

  it("does not deny approved or expired sessions", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn();
    installDb({
      desktopOnboardingDeviceSession: {
        updateMany,
        findUnique,
      },
    });

    await expect(
      desktopDeviceOnboardingService.deny({
        userCode: "ABCD1234",
        userId: "user-1",
        organizationId: "org-1",
      })
    ).resolves.toBeNull();

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userCode: "ABCD1234",
        status: "pending",
        expiresAt: { gt: expect.any(Date) },
        OR: [
          { userId: null, organizationId: null },
          { userId: "user-1", organizationId: "org-1" },
        ],
      },
      data: {
        status: "denied",
        userId: "user-1",
        organizationId: "org-1",
        deniedAt: expect.any(Date),
      },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns the denied row after denying a pending unexpired session", async () => {
    const denied = buildSession({ status: "denied", deniedAt: now });
    installDb({
      desktopOnboardingDeviceSession: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(denied),
      },
    });

    await expect(
      desktopDeviceOnboardingService.deny({
        userCode: "ABCD1234",
        userId: "user-1",
        organizationId: "org-1",
      })
    ).resolves.toEqual(denied);
  });

  it("polls pending, approved, denied, expired, and invalid sessions with exact statuses", async () => {
    const update = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve(
        buildSession(args.data as Partial<DesktopDeviceSessionRecord>)
      )
    );
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(buildSession())
      .mockResolvedValueOnce(
        buildSession({
          status: "approved",
          onboardingAttemptId: "attempt-1",
        })
      )
      .mockResolvedValueOnce(buildSession({ status: "denied" }))
      .mockResolvedValueOnce(
        buildSession({ expiresAt: new Date(now.getTime() - 60_000) })
      )
      .mockResolvedValueOnce(null);
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst,
        update,
      },
    });

    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: "019dd545-9926-7447-99fe-2671bf53acb1",
        deviceSessionSecret: "secret",
      })
    ).resolves.toEqual({ status: "pending" });
    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: "019dd545-9926-7447-99fe-2671bf53acb1",
        deviceSessionSecret: "secret",
      })
    ).resolves.toMatchObject({
      status: "approved",
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.closedloop.ai",
    });
    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: "019dd545-9926-7447-99fe-2671bf53acb1",
        deviceSessionSecret: "secret",
      })
    ).resolves.toEqual({ status: "denied" });
    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: "019dd545-9926-7447-99fe-2671bf53acb1",
        deviceSessionSecret: "secret",
      })
    ).resolves.toEqual({ status: "expired" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "expired" },
      })
    );
    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: "019dd545-9926-7447-99fe-2671bf53acb1",
        deviceSessionSecret: "secret",
      })
    ).resolves.toBeNull();
  });
});
