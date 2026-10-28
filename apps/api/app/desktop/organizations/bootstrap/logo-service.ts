import "server-only";
import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { DesktopBootstrapLogoReference } from "@repo/api/src/types/desktop-bootstrap";
import { Result } from "@repo/api/src/types/result";
import { verifyDesktopBootstrapToken } from "@repo/auth/desktop-bootstrap-jwt";
import { deleteArtifact, getSignedUploadUrl } from "@repo/aws";
import { config, s3Client } from "@repo/aws/s3-client";
import { withDb } from "@repo/database";

export const desktopBootstrapLogoService = {
  async authorize(
    bootstrapToken: string,
    logo: DesktopBootstrapLogoReference
  ): Promise<Result<{ uploadUrl: string }, "invalid">> {
    const claims = await verifyDesktopBootstrapToken(bootstrapToken).catch(
      () => null
    );
    if (!claims) {
      return Result.err("invalid" as const);
    }
    const row = await withDb((db) =>
      db.desktopBootstrapCode.findFirst({
        where: {
          id: claims.bootstrapId,
          clerkUserId: claims.clerkUserId,
          gatewayId: claims.gatewayId,
          redeemedAt: { not: null },
          completedAt: null,
        },
        select: { id: true },
      })
    );
    const ttl = Math.min(60, claims.expiresAt - Math.floor(Date.now() / 1000));
    if (!row || ttl <= 0) {
      return Result.err("invalid" as const);
    }
    const uploadUrl = await getSignedUploadUrl(
      logoKey(row.id),
      logo.type,
      ttl,
      undefined,
      logo.size
    );
    return Result.ok({ uploadUrl });
  },

  async read(
    bootstrapId: string,
    logo: DesktopBootstrapLogoReference
  ): Promise<File | null> {
    const object = await s3Client.send(
      new GetObjectCommand({
        Bucket: config.FILE_ATTACHMENTS_BUCKET,
        Key: logoKey(bootstrapId),
        // S3 enforces this range even if an object was replaced with larger bytes.
        Range: `bytes=0-${logo.size}`,
      })
    );
    if (!object.Body) {
      return null;
    }
    const bytes = await object.Body.transformToByteArray();
    if (
      bytes.length !== logo.size ||
      object.ContentType !== logo.type ||
      createHash("sha256").update(bytes).digest("hex") !== logo.sha256
    ) {
      return null;
    }
    return new File([Uint8Array.from(bytes)], logo.name, { type: logo.type });
  },

  async remove(bootstrapId: string) {
    await deleteArtifact(logoKey(bootstrapId));
  },
};

function logoKey(bootstrapId: string): string {
  // One object per bootstrap bounds staging. The existing attachments/ orphan
  // sweep removes abandoned uploads after 15m, beyond the 5m bootstrap TTL.
  // Hashing keeps identifiers out of storage paths and prevents path injection.
  return `attachments/desktop-bootstrap/${createHash("sha256").update(bootstrapId).digest("hex")}/logo`;
}
