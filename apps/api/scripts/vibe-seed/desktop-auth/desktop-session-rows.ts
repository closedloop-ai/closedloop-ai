import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@repo/database";
import { DESKTOP_REFRESH_TOKEN_TTL_MS } from "@/app/desktop/session/service";
import { ed25519SpkiBase64ToPem } from "@/lib/auth/ed25519-spki-pem";
import { hashToken } from "@/lib/auth/token-hash";
import type { VibeDesktopAuthMaterial } from "../stage";

export type VibeDesktopSessionRows = {
  readonly sessionId: string;
  readonly refreshTokenId: string;
  readonly expiresAt: Date;
};

export type VibeDesktopSessionInput = {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly organizationId: string;
  readonly material: VibeDesktopAuthMaterial;
  readonly now: Date;
};

/**
 * Writes the DesktopSession and its first DesktopRefreshToken exactly as
 * `issueDesktopSessionCredentials` (apps/api/app/desktop/session/service.ts)
 * does, except that the refresh token is the one the vibe Desktop profile
 * already holds. That function mints its own random token, so it cannot be
 * called here; the rows, the hash (`hashToken`) and the sliding window
 * (`DESKTOP_REFRESH_TOKEN_TTL_MS`) are the production ones.
 */
export async function seedVibeDesktopSession(
  input: VibeDesktopSessionInput
): Promise<VibeDesktopSessionRows> {
  const boundPublicKey = ed25519SpkiBase64ToPem(input.material.publicKeySpki);
  const tokenHash = hashToken(input.material.refreshToken);
  const existing = await input.prisma.desktopRefreshToken.findUnique({
    where: { tokenHash },
    select: { id: true },
  });
  if (existing) {
    throw new Error(
      "desktop-auth: a DesktopRefreshToken with this refresh token's hash already exists; prepare a fresh Desktop profile instead of reusing auth material"
    );
  }
  const expiresAt = new Date(
    input.now.getTime() + DESKTOP_REFRESH_TOKEN_TTL_MS
  );
  return input.prisma.$transaction(async (tx) => {
    const session = await tx.desktopSession.create({
      data: {
        userId: input.userId,
        organizationId: input.organizationId,
        gatewayId: input.material.gatewayId,
        boundPublicKey,
        metadata: {},
        expiresAt,
        lastUsedAt: input.now,
      },
      select: { id: true },
    });
    const refreshToken = await tx.desktopRefreshToken.create({
      data: {
        sessionId: session.id,
        familyId: randomUUID(),
        tokenHash,
        expiresAt,
      },
      select: { id: true },
    });
    return {
      sessionId: session.id,
      refreshTokenId: refreshToken.id,
      expiresAt,
    };
  });
}
