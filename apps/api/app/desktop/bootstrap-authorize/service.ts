import "server-only";

import { randomBytes } from "node:crypto";
import type {
  DesktopBootstrapMintResult,
  DesktopBootstrapRedeemResult,
} from "@repo/api/src/types/desktop-bootstrap";
import { isAllowedDesktopLoopbackRedirectUri } from "@repo/api/src/types/desktop-loopback-redirect";
import { Result } from "@repo/api/src/types/result";
import {
  DEFAULT_DESKTOP_BOOTSTRAP_TTL_SECONDS,
  issueDesktopBootstrapToken,
} from "@repo/auth/desktop-bootstrap-jwt";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { verifyDesktopSessionPop } from "@/lib/auth/desktop-session-pop";
import {
  isSupportedPkceMethod,
  isValidS256CodeChallenge,
  verifyPkceS256,
} from "@/lib/auth/pkce";
import { hashToken } from "@/lib/auth/token-hash";

export const DESKTOP_BOOTSTRAP_CODE_TTL_MS = 60 * 1000;

type MintInput = {
  clerkUserId: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  now?: Date;
};

type RedeemInput = {
  code: string;
  codeVerifier: string;
  gatewayId: string;
  redirectUri: string;
  request: Request;
  now?: Date;
};

export const desktopBootstrapAuthorizeService = {
  async mint(
    input: MintInput
  ): Promise<Result<DesktopBootstrapMintResult, "invalid_request">> {
    if (
      !(
        isSupportedPkceMethod(input.codeChallengeMethod) &&
        isValidS256CodeChallenge(input.codeChallenge) &&
        isAllowedDesktopLoopbackRedirectUri(input.redirectUri)
      )
    ) {
      return Result.err("invalid_request");
    }
    const now = input.now ?? new Date();
    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + DESKTOP_BOOTSTRAP_CODE_TTL_MS);
    const redeemedRetentionCutoff = new Date(
      now.getTime() - DEFAULT_DESKTOP_BOOTSTRAP_TTL_SECONDS * 1000
    );
    await withDb.tx(async (tx) => {
      await tx.desktopBootstrapCode.deleteMany({
        where: {
          OR: [
            { redeemedAt: null, expiresAt: { lte: now } },
            {
              redeemedAt: { not: null },
              expiresAt: { lte: redeemedRetentionCutoff },
            },
          ],
        },
      });
      await tx.desktopBootstrapCode.create({
        data: {
          codeHash: hashToken(code),
          clerkUserId: input.clerkUserId,
          gatewayId: input.gatewayId,
          boundPublicKey: input.gatewayPublicKeyPem,
          codeChallenge: input.codeChallenge,
          redirectUri: input.redirectUri,
          expiresAt,
        },
        select: { id: true },
      });
    });
    return Result.ok({ code, expiresAt: expiresAt.toISOString() });
  },

  async redeem(
    input: RedeemInput
  ): Promise<Result<DesktopBootstrapRedeemResult, "invalid" | "pop_failed">> {
    const now = input.now ?? new Date();
    const code = await withDb((db) =>
      db.desktopBootstrapCode.findUnique({
        where: { codeHash: hashToken(input.code) },
        select: BOOTSTRAP_CODE_REDEEM_SELECT,
      })
    );
    if (
      !code ||
      code.redeemedAt ||
      code.expiresAt <= now ||
      code.gatewayId !== input.gatewayId ||
      code.redirectUri !== input.redirectUri ||
      !verifyPkceS256(input.codeVerifier, code.codeChallenge)
    ) {
      return Result.err("invalid");
    }
    const pop = verifyDesktopSessionPop({
      request: input.request,
      boundPublicKeyPem: code.boundPublicKey,
      expectedGatewayId: code.gatewayId,
      now,
    });
    if (!pop.ok) {
      log.warn("desktop_bootstrap_redeem_pop_rejected", {
        codeId: code.id,
        gatewayId: code.gatewayId,
        reason: pop.reason,
      });
      return Result.err("pop_failed");
    }
    const token = await withDb.tx(async (tx) => {
      const claimAt = input.now ?? new Date();
      const claimed = await tx.desktopBootstrapCode.updateMany({
        where: { id: code.id, redeemedAt: null, expiresAt: { gt: claimAt } },
        data: { redeemedAt: claimAt },
      });
      if (claimed.count !== 1) {
        return null;
      }
      return await issueDesktopBootstrapToken({
        bootstrapId: code.id,
        clerkUserId: code.clerkUserId,
        gatewayId: code.gatewayId,
        issuedAt: Math.floor(claimAt.getTime() / 1000),
      });
    });
    if (!token) {
      return Result.err("invalid");
    }
    return Result.ok({
      bootstrapToken: token.token,
      expiresAt: token.expiresAt.toISOString(),
      pendingUserId: code.clerkUserId,
    });
  },
};

type BootstrapCodeRedeemRow = {
  id: string;
  clerkUserId: string;
  gatewayId: string;
  boundPublicKey: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: Date;
  redeemedAt: Date | null;
};

const BOOTSTRAP_CODE_REDEEM_SELECT = {
  id: true,
  clerkUserId: true,
  gatewayId: true,
  boundPublicKey: true,
  codeChallenge: true,
  redirectUri: true,
  expiresAt: true,
  redeemedAt: true,
} as const satisfies Record<keyof BootstrapCodeRedeemRow, true>;
