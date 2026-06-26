import { type ApiResult, failure } from "@repo/api/src/types/common";
import {
  BROWSER_KEY_UNREGISTERED_ERROR_CODE,
  type CommandSignatureFields,
} from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";
import { NextResponse } from "next/server";

type RegisteredBrowserPublicKeyInput = {
  userId: string;
  organizationId: string;
  publicKeyFingerprint: CommandSignatureFields["publicKeyFingerprint"];
};

/**
 * Looks up the browser command-signing public key for the authenticated
 * requester and organization. Shared-target commands still use the requester's
 * key, not the target owner's key.
 */
export async function isRegisteredBrowserPublicKeyForRequester(
  input: RegisteredBrowserPublicKeyInput
): Promise<boolean> {
  const row = await withDb((db) =>
    db.userPublicKey.findFirst({
      where: {
        userId: input.userId,
        organizationId: input.organizationId,
        fingerprint: input.publicKeyFingerprint,
      },
      select: { id: true },
    })
  );
  return row !== null;
}

/**
 * Standard 403 response for signed browser commands whose fingerprint is no
 * longer registered to the authenticated requester in the current org.
 */
export function browserKeyUnregisteredResponse(): NextResponse<
  ApiResult<never>
> {
  return NextResponse.json(
    failure(BROWSER_KEY_UNREGISTERED_ERROR_CODE, {
      code: BROWSER_KEY_UNREGISTERED_ERROR_CODE,
    }),
    { status: 403 }
  );
}

/**
 * Enforces central API registration for signed browser command requests.
 * Returns null when the key is registered, otherwise the route-ready 403.
 */
export async function enforceRegisteredBrowserPublicKey(
  input: RegisteredBrowserPublicKeyInput
): Promise<NextResponse<ApiResult<never>> | null> {
  return (await isRegisteredBrowserPublicKeyForRequester(input))
    ? null
    : browserKeyUnregisteredResponse();
}
