import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import { Result } from "@repo/api/src/types/result";
import { issueDesktopAccessToken } from "@repo/auth/desktop-session-jwt";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { verifyDesktopSessionPop } from "@/lib/auth/desktop-session-pop";
import { hashToken } from "@/lib/auth/token-hash";

/**
 * First-party desktop session credential service (FEA-1514 / FEA-2216).
 *
 * Turns an approved browser device-onboarding session into a desktop session
 * (short-lived access JWT from `@repo/auth/desktop-session-jwt` plus a rotating,
 * hash-only refresh token), and keeps it fresh. Exchange and refresh both
 * require a device proof-of-possession signature bound to the desktop public
 * key, so a stolen refresh token alone cannot mint a new access token.
 *
 * Never logs or returns refresh tokens, device-session secrets, access tokens,
 * or PoP signatures — log payloads carry ids and reasons only.
 */

/** Refresh-token / session sliding window. Rotated on every refresh. */
export const DESKTOP_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type DesktopSessionTokens = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  userId: string;
  organizationId: string;
};

export type DesktopSessionExchangeError =
  | "invalid"
  | "org_required"
  | "pop_failed"
  | "already_used";
export type DesktopSessionRefreshError = "invalid" | "pop_failed";
export type DesktopSessionRevokeError = "pop_failed";

export type DesktopSessionExchangeInput = {
  deviceSessionId: string;
  deviceSessionSecret: string;
  request: Request;
  now?: Date;
};

export type DesktopSessionRefreshInput = {
  refreshToken: string;
  request: Request;
  now?: Date;
};

export type DesktopSessionRevokeInput = {
  refreshToken: string;
  request: Request;
  now?: Date;
};

function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

async function revokeFamilyAndSession(input: {
  familyId: string;
  sessionId: string;
  now: Date;
}): Promise<void> {
  // No threaded `tx` parameter (AGENTS.md): withDb.tx joins the caller's
  // ambient transaction via ALS when there is one, and opens its own otherwise,
  // so the two writes stay atomic whether called standalone or nested.
  await withDb.tx(async (tx) => {
    await tx.desktopRefreshToken.updateMany({
      where: { familyId: input.familyId, revokedAt: null },
      data: { revokedAt: input.now },
    });
    await tx.desktopSession.updateMany({
      where: { id: input.sessionId, revokedAt: null },
      data: { revokedAt: input.now },
    });
  });
}

/** Display-only device metadata persisted on the session (JSON, never auth). */
export type DesktopSessionMetadata = Record<string, string>;

export type DesktopSessionIssuanceInput = {
  userId: string;
  organizationId: string;
  gatewayId: string;
  /** Device Ed25519 SPKI PEM the session + refresh family bind to for PoP. */
  boundPublicKey: string;
  metadata: DesktopSessionMetadata;
  now: Date;
};

/**
 * Create a first-party desktop session + rotating refresh-token family and mint
 * the first access token, returning the full token set. The writes run in a
 * `withDb.tx` that joins the caller's ambient transaction (ALS), so a caller can
 * gate issuance behind a one-time consume — an onboarding-attempt claim
 * (device-onboarding exchange) or an authorization-code redeem (OAuth loopback
 * flow) — and have the gate and the issuance commit atomically.
 */
export async function issueDesktopSessionCredentials(
  input: DesktopSessionIssuanceInput
): Promise<DesktopSessionTokens> {
  const refreshTokenExpiresAt = new Date(
    input.now.getTime() + DESKTOP_REFRESH_TOKEN_TTL_MS
  );
  const refreshToken = generateRefreshToken();
  const issued = await withDb.tx(async (tx) => {
    const session = await tx.desktopSession.create({
      data: {
        userId: input.userId,
        organizationId: input.organizationId,
        gatewayId: input.gatewayId,
        boundPublicKey: input.boundPublicKey,
        metadata: input.metadata,
        expiresAt: refreshTokenExpiresAt,
        lastUsedAt: input.now,
      },
    });
    const access = await issueDesktopAccessToken({
      userId: input.userId,
      organizationId: input.organizationId,
      sessionId: session.id,
      gatewayId: input.gatewayId,
    });
    await tx.desktopRefreshToken.create({
      data: {
        sessionId: session.id,
        familyId: randomUUID(),
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshTokenExpiresAt,
      },
    });
    return access;
  });
  return {
    accessToken: issued.token,
    accessTokenExpiresAt: issued.expiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    userId: input.userId,
    organizationId: input.organizationId,
  };
}

export const desktopSessionService = {
  /**
   * Exchange an approved device-onboarding session for first-party desktop
   * credentials. The one-time onboarding-attempt consume and the session/token
   * creation run in a single transaction, so if issuance fails the consume
   * rolls back and the device can retry rather than being locked out.
   */
  async exchange(
    input: DesktopSessionExchangeInput
  ): Promise<Result<DesktopSessionTokens, DesktopSessionExchangeError>> {
    const now = input.now ?? new Date();
    const deviceSession = await withDb((db) =>
      db.desktopOnboardingDeviceSession.findFirst({
        where: {
          id: input.deviceSessionId,
          deviceSessionSecretHash: hashToken(input.deviceSessionSecret),
        },
      })
    );

    if (
      !deviceSession ||
      deviceSession.status !== DesktopDeviceSessionStatus.Approved ||
      deviceSession.expiresAt <= now
    ) {
      return Result.err("invalid");
    }
    if (!(deviceSession.userId && deviceSession.organizationId)) {
      return Result.err("org_required");
    }
    if (!deviceSession.onboardingAttemptId) {
      return Result.err("invalid");
    }

    const pop = verifyDesktopSessionPop({
      request: input.request,
      boundPublicKeyPem: deviceSession.gatewayPublicKeyPem,
      expectedGatewayId: deviceSession.gatewayId,
      now,
    });
    if (!pop.ok) {
      log.warn("desktop_session_exchange_pop_rejected", {
        deviceSessionId: deviceSession.id,
        gatewayId: deviceSession.gatewayId,
        reason: pop.reason,
      });
      return Result.err("pop_failed");
    }

    const userId = deviceSession.userId;
    const organizationId = deviceSession.organizationId;
    const gatewayId = deviceSession.gatewayId;
    const onboardingAttemptId = deviceSession.onboardingAttemptId;

    // The onboarding row was approved earlier; re-read live account state so a
    // user or organization deactivated since approval cannot mint credentials.
    const activeAccount = await withDb((db) =>
      db.user.findFirst({
        where: {
          id: userId,
          active: true,
          organizationId,
          organization: { active: true },
        },
        select: { id: true },
      })
    );
    if (!activeAccount) {
      return Result.err("invalid");
    }

    const issuedTokens = await withDb.tx(async () => {
      // One-time gate joins this transaction (ambient tx via ALS), so a failure
      // below rolls the consume back. Same primitive the legacy API-key
      // bootstrap consumes -> one approval yields exactly one credential.
      const consumed = await desktopOnboardingAttemptsService.consume(
        onboardingAttemptId,
        { gatewayId }
      );
      if (!consumed) {
        return null;
      }
      return await issueDesktopSessionCredentials({
        userId,
        organizationId,
        gatewayId,
        boundPublicKey: deviceSession.gatewayPublicKeyPem,
        metadata: {
          machineName: deviceSession.machineName,
          platform: deviceSession.platform,
          desktopVersion: deviceSession.desktopVersion,
        },
        now,
      });
    });

    if (!issuedTokens) {
      return Result.err("already_used");
    }

    return Result.ok(issuedTokens);
  },

  /**
   * Rotate a refresh token. Validates session/user/org state and device PoP,
   * issues a new access + refresh token, and revokes the whole family if a
   * previously-rotated (reused) token is presented.
   */
  async refresh(
    input: DesktopSessionRefreshInput
  ): Promise<Result<DesktopSessionTokens, DesktopSessionRefreshError>> {
    const now = input.now ?? new Date();
    const current = await withDb((db) =>
      db.desktopRefreshToken.findUnique({
        where: { tokenHash: hashToken(input.refreshToken) },
        include: {
          session: {
            include: {
              user: { select: { active: true, organizationId: true } },
              organization: { select: { active: true } },
            },
          },
        },
      })
    );
    if (!current) {
      return Result.err("invalid");
    }

    // Reuse detection: a revoked or already-rotated token must never refresh.
    // Presenting one signals theft -> revoke the entire family and session.
    if (current.revokedAt || current.replacedByTokenId) {
      await revokeFamilyAndSession({
        familyId: current.familyId,
        sessionId: current.sessionId,
        now,
      });
      log.warn("desktop_session_refresh_reuse_detected", {
        sessionId: current.sessionId,
        familyId: current.familyId,
      });
      return Result.err("invalid");
    }
    if (current.expiresAt <= now) {
      return Result.err("invalid");
    }

    const session = current.session;
    if (session.revokedAt || session.expiresAt <= now) {
      return Result.err("invalid");
    }
    // User and org must still be active and the user must still belong to the
    // session's org — a 30-day refresh window must not outlive either being
    // deactivated.
    if (
      !(session.user.active && session.organization.active) ||
      session.user.organizationId !== session.organizationId
    ) {
      return Result.err("invalid");
    }

    const pop = verifyDesktopSessionPop({
      request: input.request,
      boundPublicKeyPem: session.boundPublicKey,
      expectedGatewayId: session.gatewayId,
      now,
    });
    if (!pop.ok) {
      log.warn("desktop_session_refresh_pop_rejected", {
        sessionId: session.id,
        gatewayId: session.gatewayId,
        reason: pop.reason,
      });
      return Result.err("pop_failed");
    }

    const refreshTokenExpiresAt = new Date(
      now.getTime() + DESKTOP_REFRESH_TOKEN_TTL_MS
    );
    const nextRefreshToken = generateRefreshToken();
    const gatewayId = session.gatewayId;

    const rotated = await withDb.tx(async (tx) => {
      // Optimistic single-flight claim: only the first rotation of this token
      // wins. A concurrent second rotation is treated as reuse.
      const claimed = await tx.desktopRefreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: now, lastUsedAt: now },
      });
      if (claimed.count !== 1) {
        // Joins this ambient tx via ALS, so the claim + family revoke commit
        // together.
        await revokeFamilyAndSession({
          familyId: current.familyId,
          sessionId: current.sessionId,
          now,
        });
        return null;
      }
      const created = await tx.desktopRefreshToken.create({
        data: {
          sessionId: current.sessionId,
          familyId: current.familyId,
          tokenHash: hashToken(nextRefreshToken),
          expiresAt: refreshTokenExpiresAt,
          rotatedFromTokenId: current.id,
        },
      });
      await tx.desktopRefreshToken.update({
        where: { id: current.id },
        data: { replacedByTokenId: created.id },
      });
      await tx.desktopSession.update({
        where: { id: current.sessionId },
        data: { expiresAt: refreshTokenExpiresAt, lastUsedAt: now },
      });
      return issueDesktopAccessToken({
        userId: session.userId,
        organizationId: session.organizationId,
        sessionId: session.id,
        gatewayId,
      });
    });

    if (!rotated) {
      return Result.err("invalid");
    }

    return Result.ok({
      accessToken: rotated.token,
      accessTokenExpiresAt: rotated.expiresAt.toISOString(),
      refreshToken: nextRefreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      userId: session.userId,
      organizationId: session.organizationId,
    });
  },

  /**
   * Sign-out: revoke the desktop session and its entire refresh-token family.
   * Idempotent — an unknown token resolves to success. Requires device PoP so a
   * stolen refresh token cannot be used to grief other devices.
   */
  async revoke(
    input: DesktopSessionRevokeInput
  ): Promise<Result<true, DesktopSessionRevokeError>> {
    const now = input.now ?? new Date();
    const current = await withDb((db) =>
      db.desktopRefreshToken.findUnique({
        where: { tokenHash: hashToken(input.refreshToken) },
        include: { session: true },
      })
    );
    if (!current) {
      return Result.ok(true);
    }

    const session = current.session;
    const pop = verifyDesktopSessionPop({
      request: input.request,
      boundPublicKeyPem: session.boundPublicKey,
      expectedGatewayId: session.gatewayId,
      now,
    });
    if (!pop.ok) {
      return Result.err("pop_failed");
    }

    await withDb.tx(async (tx) => {
      await tx.desktopRefreshToken.updateMany({
        where: { sessionId: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.desktopSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    return Result.ok(true);
  },
};
