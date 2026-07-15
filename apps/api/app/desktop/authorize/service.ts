import "server-only";

import { randomBytes } from "node:crypto";
import type { DesktopAuthorizeMintResult } from "@repo/api/src/types/desktop-authorize";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  type DesktopSessionTokens,
  issueDesktopSessionCredentials,
} from "@/app/desktop/session/service";
import { isAllowedDesktopLoopbackRedirectUri } from "@/lib/auth/desktop-loopback-redirect";
import { verifyDesktopSessionPop } from "@/lib/auth/desktop-session-pop";
import {
  isSupportedPkceMethod,
  isValidS256CodeChallenge,
  verifyPkceS256,
} from "@/lib/auth/pkce";
import { hashToken } from "@/lib/auth/token-hash";

/**
 * Desktop OAuth authorization-code + PKCE grant service (FEA-2409 / PLN-843
 * Amendment 1) — the API core of the native-app loopback sign-in flow (RFC 8252).
 *
 * `mint` runs behind the Clerk-authed authorize route: it binds the consenting
 * internal user/org to the device public key, the PKCE S256 challenge, and the
 * exact loopback redirect URI, and returns a one-time code the browser carries
 * back to the desktop's loopback listener. `redeem` runs at the token route:
 * given the code + PKCE verifier + device PoP it validates every binding, marks
 * the code consumed exactly once, and issues a first-party desktop session by
 * reusing {@link issueDesktopSessionCredentials}.
 *
 * The raw code is never stored or logged (SHA-256 hash only); a leaked code is
 * inert without the never-transmitted PKCE verifier AND the device private key.
 */

/** One-time authorization code lifetime. Short: the browser redirects at once. */
export const DESKTOP_AUTHORIZATION_CODE_TTL_MS = 60 * 1000;

export type DesktopAuthorizeMintInput = {
  userId: string;
  organizationId: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  now?: Date;
};

export type DesktopAuthorizeMintError = "invalid_request";

export type DesktopAuthorizeRedeemInput = {
  code: string;
  codeVerifier: string;
  gatewayId: string;
  redirectUri: string;
  request: Request;
  now?: Date;
};

export type DesktopAuthorizeRedeemError = "invalid" | "pop_failed";

function generateAuthorizationCode(): string {
  return randomBytes(32).toString("base64url");
}

export const desktopAuthorizeService = {
  /**
   * Mint a one-time authorization code for a consenting Clerk-authed user. The
   * device public key, PKCE challenge, and loopback redirect URI are validated
   * and bound to the code so only the initiating desktop can redeem it.
   */
  async mint(
    input: DesktopAuthorizeMintInput
  ): Promise<Result<DesktopAuthorizeMintResult, DesktopAuthorizeMintError>> {
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
    const code = generateAuthorizationCode();
    const expiresAt = new Date(
      now.getTime() + DESKTOP_AUTHORIZATION_CODE_TTL_MS
    );

    await withDb.tx(async (tx) => {
      // Opportunistic eviction keeps this one-time-code table bounded to the
      // live TTL window without a dedicated cron (mirrors the
      // local-gateway-jti-registry precedent). A redeemed code is safely reaped
      // once expired: a later replay then finds no row and is rejected
      // identically to an expired code.
      await tx.desktopAuthorizationCode.deleteMany({
        where: { expiresAt: { lte: now } },
      });
      await tx.desktopAuthorizationCode.create({
        data: {
          codeHash: hashToken(code),
          userId: input.userId,
          organizationId: input.organizationId,
          gatewayId: input.gatewayId,
          boundPublicKey: input.gatewayPublicKeyPem,
          codeChallenge: input.codeChallenge,
          redirectUri: input.redirectUri,
          expiresAt,
        },
      });
    });

    return Result.ok({ code, expiresAt: expiresAt.toISOString() });
  },

  /**
   * Redeem an authorization code for first-party desktop credentials. Requires
   * the PKCE verifier (hashes to the bound challenge) and a device PoP signature
   * (bound public key). The redeem is single-use via an atomic `redeemedAt`
   * claim inside the issuance transaction, so a replay yields no second session.
   */
  async redeem(
    input: DesktopAuthorizeRedeemInput
  ): Promise<Result<DesktopSessionTokens, DesktopAuthorizeRedeemError>> {
    const now = input.now ?? new Date();
    const code = await withDb((db) =>
      db.desktopAuthorizationCode.findUnique({
        where: { codeHash: hashToken(input.code) },
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
      log.warn("desktop_authorize_redeem_pop_rejected", {
        codeId: code.id,
        gatewayId: code.gatewayId,
        reason: pop.reason,
      });
      return Result.err("pop_failed");
    }

    // Re-read live account state: a user or organization deactivated since the
    // code was minted must not be able to mint credentials.
    const activeAccount = await withDb((db) =>
      db.user.findFirst({
        where: {
          id: code.userId,
          active: true,
          organizationId: code.organizationId,
          organization: { active: true },
        },
        select: { id: true },
      })
    );
    if (!activeAccount) {
      return Result.err("invalid");
    }

    const tokens = await withDb.tx(async (tx) => {
      // Single-use gate joins this transaction (ambient tx via ALS): only the
      // first redeem flips redeemedAt, so a concurrent/replayed redeem claims 0
      // rows and issues nothing. The `expiresAt` predicate makes the atomic
      // claim self-authoritative on TTL so a code cannot be claimed after expiry
      // even if validation was delayed past the read-time check.
      const claimed = await tx.desktopAuthorizationCode.updateMany({
        where: { id: code.id, redeemedAt: null, expiresAt: { gt: now } },
        data: { redeemedAt: now },
      });
      if (claimed.count !== 1) {
        return null;
      }
      return await issueDesktopSessionCredentials({
        userId: code.userId,
        organizationId: code.organizationId,
        gatewayId: code.gatewayId,
        boundPublicKey: code.boundPublicKey,
        metadata: {},
        now,
      });
    });

    if (!tokens) {
      return Result.err("invalid");
    }

    return Result.ok(tokens);
  },
};
