import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import type { DesktopOnboardingDeviceSession } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktopOnboardingAttemptsService: {
    create: vi.fn(),
    consume: vi.fn(),
  },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  verifyDesktopSessionPop: vi.fn(),
  issueDesktopAccessToken: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@/app/desktop/onboarding-attempt/service", () => ({
  desktopOnboardingAttemptsService: mocks.desktopOnboardingAttemptsService,
}));

// ISS-8132: `desktopSessionService` is imported alongside the onboarding
// service so ONE fixture row can be driven through both expiry readers in a
// single case. These three mocks exist only to let that module load — the
// expiry refusal returns before PoP verification or token issuance is reached.
vi.mock("@/lib/auth/desktop-session-pop", () => ({
  verifyDesktopSessionPop: mocks.verifyDesktopSessionPop,
}));
vi.mock("@repo/auth/desktop-session-jwt", () => ({
  issueDesktopAccessToken: mocks.issueDesktopAccessToken,
}));
vi.mock("@repo/observability/log", () => ({ log: mocks.log }));

import { desktopSessionService } from "../session/service";
import {
  DESKTOP_DEVICE_SESSION_RATE_LIMIT_MAX,
  desktopDeviceOnboardingService,
} from "./service";

const now = new Date("2026-04-28T17:00:00.000Z");
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const STARTED_DEVICE_SESSION_ID = "019dd545-9926-7447-99fe-2671bf53acb1";

function installDb(db: unknown) {
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
}

/**
 * A whole stored row, secrets included — what the DB holds, not what any read
 * of it returns. It is typed off the Prisma model rather than a service return
 * type so a narrowed projection cannot silently narrow the fixture with it.
 */
function buildSession(
  overrides: Partial<DesktopOnboardingDeviceSession> = {}
): DesktopOnboardingDeviceSession {
  return {
    id: "019dd545-9926-7447-99fe-2671bf53acb1",
    deviceSessionSecretHash: "hash",
    userCode: "ABCD1234",
    requestIpHash: null,
    webAppOrigin: "https://app.closedloop.ai",
    gatewayId: "019dd545-b11d-444d-9956-0310752e2481",
    gatewayPublicKeyPem:
      "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
    machineName: "Daveth-MBP",
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
  machineName: "Daveth-MBP",
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

  // ISS-9195. The falsifiable assertion is the one on the `select` the query
  // carries, not on a projected row: this create is the one write here the
  // projection double cannot drive (it models neither `create` nor the `count`
  // rate-limit read that precedes it). The mock resolves the narrow row
  // Postgres would return so the second assertion pins which field the caller
  // consumes; it does not itself redden on a widened select.
  it("asks for only the new row's id, so the secret hash it just wrote never comes back", async () => {
    let createArgs: { select?: Record<string, boolean> } | undefined;
    installDb({
      desktopOnboardingDeviceSession: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn((args: { select?: Record<string, boolean> }) => {
          createArgs = args;
          return Promise.resolve({ id: STARTED_DEVICE_SESSION_ID });
        }),
      },
    });

    const result = await desktopDeviceOnboardingService.start(startInput);

    expect(createArgs?.select).toEqual({ id: true });
    expect(result).toMatchObject({
      status: "started",
      deviceSessionId: STARTED_DEVICE_SESSION_ID,
    });
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

  // ISS-8132. The call counts are the load-bearing assertions, not the reject:
  // widening the catch to swallow every error (retrying a genuine DB fault five
  // times) and narrowing the loop to a single attempt BOTH leave a bare
  // `.rejects` green. The code and the attempt ceiling are written here
  // independently of `service.ts` so changing either one reddens a row.
  it("rethrows a non-collision create failure without retrying", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("connection reset"), { code: "P1001" })
      );
    installDb({
      desktopOnboardingDeviceSession: {
        count: vi.fn().mockResolvedValue(0),
        create,
      },
    });

    await expect(
      desktopDeviceOnboardingService.start({ ...startInput, requestIp: null })
    ).rejects.toThrow("connection reset");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries a user-code collision exactly five times before giving up", async () => {
    const collision = Object.assign(new Error("unique constraint"), {
      code: "P2002",
    });
    const create = vi.fn().mockRejectedValue(collision);
    installDb({
      desktopOnboardingDeviceSession: {
        count: vi.fn().mockResolvedValue(0),
        create,
      },
    });

    await expect(
      desktopDeviceOnboardingService.start({ ...startInput, requestIp: null })
    ).rejects.toBe(collision);
    expect(create).toHaveBeenCalledTimes(5);
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
    let updateArgs: { data: Record<string, unknown> } | undefined;
    installDb({
      desktopOnboardingDeviceSession: {
        findUnique: vi.fn().mockResolvedValue(buildSession()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn((args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return Promise.resolve(
            buildSession({
              status: "approved",
              userId: "user-1",
              organizationId: "org-1",
              approvedAt: now,
              ...(args.data as Partial<DesktopOnboardingDeviceSession>),
            })
          );
        }),
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
    // ISS-9195 narrowed the RETURNING list, so the minted attempt id is no
    // longer readable off the returned row. It is still the point of this
    // case, so it is asserted where it is now observable: the write payload.
    expect(updateArgs?.data.onboardingAttemptId).toBe("attempt-1");
  });

  // ISS-8132. One row per arm of `session?.status !== Pending ||
  // session.expiresAt <= now`. This replaces a single fixture that was both
  // denied AND expired, which satisfied both halves of the `||` at once — so
  // dropping either half left it green and the unknown-code arm was never
  // claimed at all. The denied+expired row is kept as its own case so nothing
  // that case covered became uncovered.
  const unapprovableSessions = [
    { name: "the user code is unknown", row: null },
    {
      name: "the code was already claimed",
      row: () => buildSession({ status: "approved" }),
    },
    {
      name: "the code timed out while still pending",
      row: () => buildSession({ expiresAt: new Date(now.getTime() - 60_000) }),
    },
    {
      name: "the code was denied and has since expired",
      row: () =>
        buildSession({
          status: "denied",
          expiresAt: new Date(now.getTime() - 60_000),
        }),
    },
  ];

  it.each(unapprovableSessions)(
    "returns null without claiming or minting an attempt when $name",
    async ({ row }) => {
      const updateMany = vi.fn();
      const update = vi.fn();
      installDb({
        desktopOnboardingDeviceSession: {
          findUnique: vi.fn().mockResolvedValue(row ? row() : null),
          updateMany,
          update,
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
      expect(updateMany).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    }
  );

  // ISS-8132. Between the `findUnique` read and the `updateMany` claim, a
  // concurrent browser tab can take the same code. Delete the `claimed.count
  // !== 1` guard and two approvals each mint an onboarding attempt for one
  // device code — the write is idempotent, the attempt is not.
  it("returns null without minting an attempt when a concurrent claim wins the race", async () => {
    const update = vi.fn();
    installDb({
      desktopOnboardingDeviceSession: {
        findUnique: vi.fn().mockResolvedValue(buildSession()),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update,
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
    expect(update).not.toHaveBeenCalled();
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
    const stored = buildSession({
      status: DesktopDeviceSessionStatus.Denied,
      deniedAt: now,
    });
    // ISS-9268: the seven columns the narrowed lookup projects out of that
    // stored row. This mock echoes whatever it is handed, so it characterizes
    // the claim-then-read sequencing, NOT the select — the projecting double in
    // `read-narrowing-projection-desktop.test.ts` is what proves the narrowing.
    const denied = {
      userCode: stored.userCode,
      machineName: stored.machineName,
      platform: stored.platform,
      webAppOrigin: stored.webAppOrigin,
      status: stored.status,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    };
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
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
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
        updateMany,
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
    // The status predicate rides in the WHERE so a concurrent approval cannot
    // be overwritten; asserting the whole call is what pins that.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "019dd545-9926-7447-99fe-2671bf53acb1",
        status: "pending",
      },
      data: { status: "expired" },
    });
    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: "019dd545-9926-7447-99fe-2671bf53acb1",
        deviceSessionSecret: "secret",
      })
    ).resolves.toBeNull();
  });

  // ISS-8132 BUG 1. The defect was a DISAGREEMENT, so the fix is only proven by
  // driving ONE row through BOTH readers: poll used to answer `approved` here
  // while `exchange` refused the same row on `expiresAt` with a non-retryable
  // 401, so the desktop was told to advance into a terminal refusal. Asserting
  // poll's new value alone would stay green if exchange's clock later drifted.
  it("refuses an approved-but-expired row on both poll and exchange", async () => {
    const updateMany = vi.fn();
    const expiredApproval = buildSession({
      status: "approved",
      onboardingAttemptId: "attempt-1",
      userId: "user-1",
      organizationId: "org-1",
      approvedAt: now,
      expiresAt: new Date(now.getTime() - 60_000),
    });
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst: vi.fn().mockResolvedValue(expiredApproval),
        updateMany,
      },
    });

    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: expiredApproval.id,
        deviceSessionSecret: "secret",
      })
    ).resolves.toEqual({ status: "expired" });

    await expect(
      desktopSessionService.exchange({
        deviceSessionId: expiredApproval.id,
        deviceSessionSecret: "secret",
        request: new Request("https://api.test/desktop/session/exchange", {
          method: "POST",
        }),
      })
    ).resolves.toEqual({ ok: false, error: "invalid" });

    // Reporting the expiry must not overwrite the approval record. The
    // persisted fold stays scoped to pending rows; approve()/deny() already
    // refuse this row on `expiresAt` alone, so the write buys nothing.
    expect(updateMany).not.toHaveBeenCalled();
  });

  // ISS-8132. The 5-fixture case above covers the FOLD (pending + past expiry,
  // which writes), never the read-back of a row already folded. The desktop
  // polls every 5s, so a second write per poll is the part worth pinning.
  it("reports an already-folded row as expired without writing again", async () => {
    const updateMany = vi.fn();
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst: vi.fn().mockResolvedValue(
          buildSession({
            status: "expired",
            expiresAt: new Date(now.getTime() - 60_000),
          })
        ),
        updateMany,
      },
    });

    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: "019dd545-9926-7447-99fe-2671bf53acb1",
        deviceSessionSecret: "secret",
      })
    ).resolves.toEqual({ status: "expired" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  // ISS-8132. The route-level 401 case mocks `poll()` outright, so it pins the
  // null-to-401 mapping and nothing about WHY poll returns null for a wrong
  // secret. Drop `deviceSessionSecretHash` from this query and the id alone
  // would let any caller read approval state and onboarding-attempt metadata,
  // with that route test still green. The hash is asserted by shape rather than
  // recomputed, so this cannot pass by repeating the production formula.
  it("scopes the poll lookup to the hashed secret, not the session id alone", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    installDb({
      desktopOnboardingDeviceSession: { findFirst, updateMany: vi.fn() },
    });

    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: "019dd545-9926-7447-99fe-2671bf53acb1",
        deviceSessionSecret: "secret",
      })
    ).resolves.toBeNull();

    // `objectContaining` at the TOP level only: the `where` below is still
    // matched exactly, so the scoping contract this test exists for is
    // unweakened. It stops the read's RETURNING list (ISS-9188) from being an
    // assertion of this test, which is not what it is about — the columns that
    // read may return are pinned by its own projection case.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "019dd545-9926-7447-99fe-2671bf53acb1",
          deviceSessionSecretHash: expect.stringMatching(SHA256_HEX_RE),
        },
      })
    );
    const [call] = findFirst.mock.calls as [
      [{ where: { deviceSessionSecretHash: string } }],
    ];
    expect(call[0].where.deviceSessionSecretHash).not.toBe("secret");
  });

  // ISS-8132 item 9. PINS CURRENT BEHAVIOUR, which is arguably the wrong word:
  // `pending` reads as "still waiting for the user" for a row the user already
  // approved. `approve()` sets the status and the attempt id in one
  // transaction, so this should not be reachable through it — but poll reads a
  // PERSISTED row, and today the `&& row.onboardingAttemptId` half of the
  // approved arm silently reclassifies it. Not changed here; see the PR.
  it("reports an approved row with no attempt id as pending", async () => {
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst: vi.fn().mockResolvedValue(
          buildSession({
            status: "approved",
            onboardingAttemptId: null,
          })
        ),
        updateMany: vi.fn(),
      },
    });

    await expect(
      desktopDeviceOnboardingService.poll({
        deviceSessionId: "019dd545-9926-7447-99fe-2671bf53acb1",
        deviceSessionSecret: "secret",
      })
    ).resolves.toEqual({ status: "pending" });
  });
});
