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

export type DesktopDeviceSessionRecord = {
  id: string;
  deviceSessionSecretHash: string;
  userCode: string;
  requestIpHash: string | null;
  webAppOrigin: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
  machineName: string;
  platform: string;
  desktopVersion: string;
  desktopSecurityUpgradeProtocolVersion: number;
  status: string;
  userId: string | null;
  organizationId: string | null;
  onboardingAttemptId: string | null;
  deniedAt: Date | null;
  approvedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

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

  getByUserCode(userCode: string): Promise<DesktopDeviceSessionRecord | null> {
    return withDb((db) =>
      db.desktopOnboardingDeviceSession.findUnique({
        where: { userCode },
      })
    );
  },

  approve(input: {
    userCode: string;
    userId: string;
    organizationId: string;
  }): Promise<DesktopDeviceSessionRecord | null> {
    return withDb.tx(async (db) => {
      const session = await db.desktopOnboardingDeviceSession.findUnique({
        where: { userCode: input.userCode },
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
      });
    });
  },

  async deny(input: {
    userCode: string;
    userId: string;
    organizationId: string;
  }): Promise<DesktopDeviceSessionRecord | null> {
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
      })
    );
    if (!row) {
      return null;
    }
    if (
      row.expiresAt <= new Date() &&
      row.status === DesktopDeviceSessionStatus.Pending
    ) {
      await withDb((db) =>
        db.desktopOnboardingDeviceSession.update({
          where: { id: row.id },
          data: { status: DesktopDeviceSessionStatus.Expired },
        })
      );
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
