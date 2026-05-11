import type {
  OrganizationPublicKeySummary,
  PublicKeyRegistrationRequest,
  UserPublicKeySummary,
} from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { publicKeysService } from "./service";
import {
  publicKeyRegistrationValidator,
  publicKeyUnregisterValidator,
} from "./validators";

function publicKeyRegistrationErrorMessage(reason: string): string {
  switch (reason) {
    case "fingerprint_mismatch":
      return "Fingerprint does not match public key";
    case "unsupported_public_key":
      return "Public key must be a raw Ed25519 public key";
    default:
      return "Malformed public key";
  }
}

/**
 * GET /public-keys
 * Returns same-organization browser command-signing public keys visible to the
 * authenticated caller for local Desktop authorization.
 */
export const GET = withAnyAuth<OrganizationPublicKeySummary[], "/public-keys">(
  async ({ user }) => {
    try {
      const keys = await publicKeysService.listOrganizationPublicKeys(
        user.organizationId
      );
      return successResponse(keys);
    } catch (error) {
      return errorResponse("Failed to list public keys", error);
    }
  }
);

/**
 * POST /public-keys
 * Registers the authenticated user's browser command-signing public key.
 */
export const POST = withAuth<UserPublicKeySummary, "/public-keys">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        publicKeyRegistrationValidator
      );
      if (parseError || !body) {
        return parseError;
      }

      const result = await publicKeysService.registerUserPublicKey({
        userId: user.id,
        organizationId: user.organizationId,
        payload: body as PublicKeyRegistrationRequest,
      });

      if (!result.ok) {
        return badRequestResponse(
          publicKeyRegistrationErrorMessage(result.error)
        );
      }

      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to register public key", error);
    }
  }
);

/**
 * DELETE /public-keys?fingerprint=...
 * Unregisters the authenticated user's browser command-signing public key.
 * The browser clears its local private key only after this server call
 * succeeds, so a failed unregister leaves the signing pair recoverable.
 */
export const DELETE = withAuth<{ deleted: boolean }, "/public-keys">(
  async ({ user }, request) => {
    try {
      const parsed = publicKeyUnregisterValidator.safeParse({
        fingerprint: new URL(request.url).searchParams.get("fingerprint"),
      });
      if (!parsed.success) {
        return badRequestResponse("Malformed public key fingerprint");
      }

      const result = await publicKeysService.unregisterUserPublicKey({
        userId: user.id,
        organizationId: user.organizationId,
        fingerprint: parsed.data.fingerprint,
      });

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to unregister public key", error);
    }
  }
);
