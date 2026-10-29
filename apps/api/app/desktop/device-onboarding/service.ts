import { createHash, randomBytes } from "node:crypto";
import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import { withDb } from "@repo/database";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { getPrismaErrorCode } from "@/lib/db-utils";

export const DESKTOP_DEVICE_SESSION_TTL_MS = 10 * 60 * 1000;
export const DESKTOP_DEVICE_POLL_INTERVAL_SECONDS = 5;
export const DESKTOP_DEVICE_SESSION_RATE_LIMIT_MAX = 5;
const NON_ALPHANUMERIC_CODE_CHARS_RE = /[^A-Z0-9]/gi;

export type DesktopDeviceSessionStartInput = {
  webAppOrigin: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
  machineName: string;
  platform: string;
  desktopVersion: string;
  desktopSecurityUpgradeProtocolVersion: 1;
  requestIp?: string | null;
};

export type DesktopDeviceSessionStartResult = {
  status: "started";
  deviceSessionId: string;
  deviceSessionSecret: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: Date;
  pollIntervalSeconds: number;
};

export type DesktopDeviceSessionStartRateLimitedResult = {
  status: "rate_limited";
};

export type DesktopDeviceSessionStartOutcome =
  | DesktopDeviceSessionStartResult
  | DesktopDeviceSessionStartRateLimitedResult;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function hashRequestIp(requestIp: string | null | undefined): string | null {
  const normalized = requestIp?.trim().toLowerCase();
  return normalized
    ? createHash("sha256")
        .update(`desktop-device-ip:${normalized}`, "utf8")
        .digest("hex")
    : null;
}

function createUserCode(): string {
  return randomBytes(8)
    .toString("base64url")
    .replaceAll(NON_ALPHANUMERIC_CODE_CHARS_RE, "")
    .slice(0, 8)
    .toUpperCase();
}

function createDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

export const desktopDeviceOnboardingService = {
  /**
   * Persists a pending Desktop-first browser approval session.
   */
  async start(
    input: DesktopDeviceSessionStartInput
  ): Promise<DesktopDeviceSessionStartOutcome> {
    const deviceSessionSecret = createDeviceSecret();
    const expiresAt = new Date(Date.now() + DESKTOP_DEVICE_SESSION_TTL_MS);
    const requestIpHash = hashRequestIp(input.requestIp);
    let lastError: unknown;

    const activeSessionCount = await withDb((db) =>
      db.desktopOnboardingDeviceSession.count({
        where: {
          status: DesktopDeviceSessionStatus.Pending,
          expiresAt: { gt: new Date() },
          OR: [
            { gatewayId: input.gatewayId },
            ...(requestIpHash ? [{ requestIpHash }] : []),
          ],
        },
      })
    );
    if (activeSessionCount >= DESKTOP_DEVICE_SESSION_RATE_LIMIT_MAX) {
      return { status: "rate_limited" };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const userCode = createUserCode();
      try {
        const row = await withDb((db) =>
          db.desktopOnboardingDeviceSession.create({
            data: {
              deviceSessionSecretHash: hashSecret(deviceSessionSecret),
              userCode,
              requestIpHash,
              webAppOrigin: input.webAppOrigin,
              gatewayId: input.gatewayId,
              gatewayPublicKeyPem: input.gatewayPublicKeyPem,
              machineName: input.machineName,
              platform: input.platform,
              desktopVersion: input.desktopVersion,
              desktopSecurityUpgradeProtocolVersion:
                input.desktopSecurityUpgradeProtocolVersion,
              status: DesktopDeviceSessionStatus.Pending,
              expiresAt,
            },
            // The id is the whole answer: every other field of the started
            // session is already in hand here, and an unnarrowed create would
            // materialize the secret hash this method just wrote.
            select: { id: true },
          })
        );

        return {
          status: "started",
          deviceSessionId: row.id,
          deviceSessionSecret,
          userCode,
          verificationUrl: `${input.webAppOrigin}/settings/integrations/desktop/connect?code=${encodeURIComponent(userCode)}`,
          expiresAt,
          pollIntervalSeconds: DESKTOP_DEVICE_POLL_INTERVAL_SECONDS,
        };
      } catch (error) {
        lastError = error;
        if (getPrismaErrorCode(error) !== "P2002") {
          throw error;
        }
      }
    }

    throw lastError;
  },

  getByUserCode(userCode: string): Promise<DeviceSessionLookupRow | null> {
    return withDb((db) =>
      db.desktopOnboardingDeviceSession.findUnique({
        where: { userCode },
        // ISS-9268: both consumers answer the browser approval page out of this
        // row, and neither reads a credential — an unnarrowed read carried
        // `deviceSessionSecretHash` into process memory for no reader.
        select: DEVICE_SESSION_LOOKUP_SELECT,
      })
    );
  },

  approve(input: {
    userCode: string;
    userId: string;
    organizationId: string;
  }): Promise<DeviceSessionApprovalRow | null> {
    return withDb.tx(async (db) => {
      const session = await db.desktopOnboardingDeviceSession.findUnique({
        where: { userCode: input.userCode },
        select: DEVICE_SESSION_CLAIM_SELECT,
      });
      const now = new Date();
      if (
        session?.status !== DesktopDeviceSessionStatus.Pending ||
        session.expiresAt <= now
      ) {
        return null;
      }

      const claimed = await db.desktopOnboardingDeviceSession.updateMany({
        where: {
          id: session.id,
          status: DesktopDeviceSessionStatus.Pending,
          expiresAt: { gt: now },
        },
        data: {
          status: DesktopDeviceSessionStatus.Approved,
          userId: input.userId,
          organizationId: input.organizationId,
          approvedAt: now,
        },
      });
      if (claimed.count !== 1) {
        return null;
      }

      const attempt = await desktopOnboardingAttemptsService.create({
        organizationId: input.organizationId,
        userId: input.userId,
        webAppOrigin: session.webAppOrigin,
        flowType: "desktop_first_connect",
        gatewayId: session.gatewayId,
      });

      return db.desktopOnboardingDeviceSession.update({
        where: { id: session.id },
        data: {
          onboardingAttemptId: attempt.onboardingAttemptId,
        },
        // ISS-9195: a write's RETURNING is disclosure exactly as a read's is,
        // and this row's is the approval response body. Unnarrowed it carried
        // `deviceSessionSecretHash` into process memory for a payload of four
        // presentation fields.
        select: DEVICE_SESSION_APPROVAL_SELECT,
      });
    });
  },

  async deny(input: {
    userCode: string;
    userId: string;
    organizationId: string;
  }): Promise<DeviceSessionLookupRow | null> {
    const now = new Date();
    const result = await withDb((db) =>
      db.desktopOnboardingDeviceSession.updateMany({
        where: {
          userCode: input.userCode,
          status: DesktopDeviceSessionStatus.Pending,
          expiresAt: { gt: now },
          OR: [
            { userId: null, organizationId: null },
            { userId: input.userId, organizationId: input.organizationId },
          ],
        },
        data: {
          status: DesktopDeviceSessionStatus.Denied,
          userId: input.userId,
          organizationId: input.organizationId,
          deniedAt: now,
        },
      })
    );

    if (!result?.count) {
      return null;
    }

    return this.getByUserCode(input.userCode);
  },

  async poll(input: {
    deviceSessionId: string;
    deviceSessionSecret: string;
  }): Promise<
    | {
        status:
          | typeof DesktopDeviceSessionStatus.Pending
          | typeof DesktopDeviceSessionStatus.Denied
          | typeof DesktopDeviceSessionStatus.Expired;
      }
    | {
        status: typeof DesktopDeviceSessionStatus.Approved;
        onboardingAttemptId: string;
        webAppOrigin: string;
        expiresAt: string;
      }
    | null
  > {
    const row = await withDb((db) =>
      db.desktopOnboardingDeviceSession.findFirst({
        where: {
          id: input.deviceSessionId,
          deviceSessionSecretHash: hashSecret(input.deviceSessionSecret),
        },
        // Poll answers with a status word plus the approved-handoff triple; the
        // secret hash it matched on is a predicate, never part of that answer.
        select: DEVICE_SESSION_POLL_SELECT,
      })
    );
    if (!row) {
      return null;
    }
    // ISS-8132: expiry is reported off `expiresAt` ALONE, so poll and
    // `/desktop/session/exchange` run one clock. Gating the report on
    // `status === Pending` let an approved-but-expired row poll as `approved`
    // while exchange refused the same row on `expiresAt` with a non-retryable
    // 401 — poll said go, exchange said never. The persisted fold below stays
    // scoped to Pending: flipping an Approved row to Expired would discard the
    // approval record for no read that needs it, and approve()/deny() already
    // refuse an expired row on `expiresAt` alone.
    if (row.expiresAt <= new Date()) {
      if (row.status === DesktopDeviceSessionStatus.Pending) {
        // `updateMany` with the status in the WHERE, not `update` by id: the
        // status above came from a stale read, and at the TTL boundary a
        // browser approval can commit between the two. An unconditional write
        // would stamp Expired over that Approved row and strand the onboarding
        // attempt it just minted.
        await withDb((db) =>
          db.desktopOnboardingDeviceSession.updateMany({
            where: {
              id: row.id,
              status: DesktopDeviceSessionStatus.Pending,
            },
            data: { status: DesktopDeviceSessionStatus.Expired },
          })
        );
      }
      return { status: DesktopDeviceSessionStatus.Expired };
    }
    if (
      row.status === DesktopDeviceSessionStatus.Approved &&
      row.onboardingAttemptId
    ) {
      return {
        status: DesktopDeviceSessionStatus.Approved,
        onboardingAttemptId: row.onboardingAttemptId,
        webAppOrigin: row.webAppOrigin,
        expiresAt: row.expiresAt.toISOString(),
      };
    }
    if (row.status === DesktopDeviceSessionStatus.Denied) {
      return { status: DesktopDeviceSessionStatus.Denied };
    }
    if (row.status === DesktopDeviceSessionStatus.Expired) {
      return { status: DesktopDeviceSessionStatus.Expired };
    }
    return { status: DesktopDeviceSessionStatus.Pending };
  },
};

/** The columns `approve` validates before it claims the row. */
type DeviceSessionClaimRow = {
  id: string;
  status: string;
  expiresAt: Date;
  webAppOrigin: string;
  gatewayId: string;
};

const DEVICE_SESSION_CLAIM_SELECT = {
  id: true,
  status: true,
  expiresAt: true,
  webAppOrigin: true,
  gatewayId: true,
} as const satisfies Record<keyof DeviceSessionClaimRow, true>;

/** The columns `poll` folds into its status answer. */
type DeviceSessionPollRow = {
  id: string;
  status: string;
  expiresAt: Date;
  onboardingAttemptId: string | null;
  webAppOrigin: string;
};

const DEVICE_SESSION_POLL_SELECT = {
  id: true,
  status: true,
  expiresAt: true,
  onboardingAttemptId: true,
  webAppOrigin: true,
} as const satisfies Record<keyof DeviceSessionPollRow, true>;

/** The columns `approve` answers the browser approval page with. */
export type DeviceSessionApprovalRow = {
  status: string;
  machineName: string;
  platform: string;
  webAppOrigin: string;
};

const DEVICE_SESSION_APPROVAL_SELECT = {
  status: true,
  machineName: true,
  platform: true,
  webAppOrigin: true,
} as const satisfies Record<keyof DeviceSessionApprovalRow, true>;

/**
 * The columns the user-code lookup answers with — the union of what its two
 * consumers read, and nothing else. `deny` takes the four the approve route
 * serializes; the session route serializes those plus three more of its own.
 *
 * Narrowing the TYPE alongside the select is what makes this safe: this row is
 * returned verbatim, so a consumer reaching for a dropped column now fails
 * typecheck instead of silently reading `undefined`.
 */
type DeviceSessionLookupRow = {
  userCode: string;
  machineName: string;
  platform: string;
  webAppOrigin: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
};

const DEVICE_SESSION_LOOKUP_SELECT = {
  userCode: true,
  machineName: true,
  platform: true,
  webAppOrigin: true,
  status: true,
  createdAt: true,
  expiresAt: true,
} as const satisfies Record<keyof DeviceSessionLookupRow, true>;
