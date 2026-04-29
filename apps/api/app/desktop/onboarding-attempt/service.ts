import { randomBytes } from "node:crypto";
import { withDb } from "@repo/database";

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

function createAttemptId(): string {
  return randomBytes(32).toString("base64url");
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
  async consume(onboardingAttemptId: string): Promise<boolean> {
    const now = new Date();
    const { count } = await withDb((db) =>
      db.desktopOnboardingAttempt.updateMany({
        where: {
          attemptId: onboardingAttemptId,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      })
    );

    return count === 1;
  },
};
