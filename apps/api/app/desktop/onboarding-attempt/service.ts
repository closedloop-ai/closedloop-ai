import { randomBytes } from "node:crypto";
import {
  DesktopProvisioningAttemptStatus,
  type DesktopProvisioningAttemptStatusResponse,
  type DesktopProvisioningReadinessResponse,
  DesktopProvisioningReadinessStatus,
} from "@repo/api/src/types/electron";
import { ApiKeySource, withDb } from "@repo/database";

export const DESKTOP_ONBOARDING_ATTEMPT_TTL_MS = 60 * 60 * 1000;

export type DesktopOnboardingAttemptRecord = {
  attemptId: string;
  userId: string;
  organizationId: string;
  webAppOrigin: string;
  expiresAt: Date;
  consumedAt: Date | null;
  flowType?: string | null;
  computeTargetId?: string | null;
  gatewayId?: string | null;
};

/** Creates and persists a single-use onboarding attempt for desktop bootstrap. */
type CreateDesktopOnboardingAttemptInput = {
  userId: string;
  organizationId: string;
  webAppOrigin: string;
  flowType?:
    | "installer_handoff"
    | "compute_target_upgrade"
    | "desktop_first_connect";
  computeTargetId?: string;
  gatewayId?: string;
};

type ReadyDesktopTarget = {
  computeTargetId: string;
  gatewayId: string;
};

function createAttemptId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Finds an online Desktop target whose gateway id is protected by a non-revoked
 * Desktop-managed PoP key owned by the same user and organization.
 */
function findReadyDesktopTarget(input: {
  organizationId: string;
  userId: string;
  gatewayId?: string;
}): Promise<ReadyDesktopTarget | null> {
  return withDb(async (db) => {
    const managedKeys = await db.apiKey.findMany({
      where: {
        organizationId: input.organizationId,
        userId: input.userId,
        ...(input.gatewayId
          ? { gatewayId: input.gatewayId }
          : { gatewayId: { not: null } }),
        source: ApiKeySource.DESKTOP_MANAGED,
        revokedAt: null,
        boundPublicKey: { not: null },
      },
      select: { gatewayId: true },
    });

    const protectedGatewayIds = managedKeys.flatMap((key) =>
      key.gatewayId ? [key.gatewayId] : []
    );
    if (protectedGatewayIds.length === 0) {
      return null;
    }

    const readyTarget = await db.computeTarget.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.userId,
        gatewayId: { in: protectedGatewayIds },
        isOnline: true,
      },
      select: { id: true, gatewayId: true },
    });

    if (!readyTarget?.gatewayId) {
      return null;
    }

    return {
      computeTargetId: readyTarget.id,
      gatewayId: readyTarget.gatewayId,
    };
  });
}

export const desktopOnboardingAttemptsService = {
  /**
   * Persists a new onboarding attempt with a fixed 60 minute TTL.
   */
  async create(
    input: CreateDesktopOnboardingAttemptInput
  ): Promise<{ onboardingAttemptId: string; expiresAt: Date }> {
    const onboardingAttemptId = createAttemptId();
    const expiresAt = new Date(Date.now() + DESKTOP_ONBOARDING_ATTEMPT_TTL_MS);

    await withDb((db) =>
      db.desktopOnboardingAttempt.create({
        data: {
          attemptId: onboardingAttemptId,
          userId: input.userId,
          organizationId: input.organizationId,
          webAppOrigin: input.webAppOrigin,
          expiresAt,
          consumedAt: null,
          flowType: input.flowType ?? null,
          computeTargetId: input.computeTargetId ?? null,
          gatewayId: input.gatewayId ?? null,
        },
      })
    );

    return { onboardingAttemptId, expiresAt };
  },

  /**
   * Loads the persisted onboarding attempt so the claim route can validate it.
   */
  get(
    onboardingAttemptId: string
  ): Promise<DesktopOnboardingAttemptRecord | null> {
    return withDb((db) =>
      db.desktopOnboardingAttempt.findUnique({
        where: { attemptId: onboardingAttemptId },
      })
    );
  },

  /**
   * Consumes an onboarding attempt exactly once after claim validation succeeds.
   */
  async consume(
    onboardingAttemptId: string,
    options?: { gatewayId?: string }
  ): Promise<boolean> {
    const now = new Date();
    const { count } = await withDb((db) =>
      db.desktopOnboardingAttempt.updateMany({
        where: {
          attemptId: onboardingAttemptId,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          consumedAt: now,
          ...(options?.gatewayId ? { gatewayId: options.gatewayId } : {}),
        },
      })
    );

    return count === 1;
  },

  async getStatus(
    onboardingAttemptId: string,
    organizationId: string,
    userId: string
  ): Promise<DesktopProvisioningAttemptStatusResponse | null> {
    const attempt = await withDb((db) =>
      db.desktopOnboardingAttempt.findFirst({
        where: {
          attemptId: onboardingAttemptId,
          organizationId,
          userId,
        },
      })
    );
    if (!attempt) {
      return null;
    }

    const base = {
      onboardingAttemptId: attempt.attemptId,
      expiresAt: attempt.expiresAt.toISOString(),
      ...(attempt.gatewayId ? { gatewayId: attempt.gatewayId } : {}),
      ...(attempt.computeTargetId
        ? { computeTargetId: attempt.computeTargetId }
        : {}),
    };
    if (attempt.expiresAt <= new Date()) {
      return { ...base, status: DesktopProvisioningAttemptStatus.Expired };
    }
    if (!(attempt.consumedAt && attempt.gatewayId)) {
      return { ...base, status: DesktopProvisioningAttemptStatus.Pending };
    }

    const readyTarget = await findReadyDesktopTarget({
      organizationId,
      userId,
      gatewayId: attempt.gatewayId,
    });

    if (readyTarget) {
      return {
        ...base,
        status: DesktopProvisioningAttemptStatus.Complete,
        computeTargetId: attempt.computeTargetId ?? readyTarget.computeTargetId,
      };
    }

    return { ...base, status: DesktopProvisioningAttemptStatus.Claimed };
  },

  /**
   * Reports whether this account already has an online protected Desktop target.
   */
  async getReadiness(
    organizationId: string,
    userId: string
  ): Promise<DesktopProvisioningReadinessResponse> {
    const readyTarget = await findReadyDesktopTarget({
      organizationId,
      userId,
    });
    if (!readyTarget) {
      return { status: DesktopProvisioningReadinessStatus.Incomplete };
    }

    return {
      status: DesktopProvisioningReadinessStatus.Complete,
      gatewayId: readyTarget.gatewayId,
      computeTargetId: readyTarget.computeTargetId,
    };
  },
};
