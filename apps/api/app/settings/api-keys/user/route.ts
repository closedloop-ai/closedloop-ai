import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  deleteResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { apiKeyService } from "../../api-key-service";
import { setApiKeyValidator } from "../validators";

type SetKeyResponse = { isSet: boolean; lastFour: string | null };

/**
 * PUT /settings/api-keys/user
 * Set the user-level Claude API key override.
 * Validates format and tests the key against the Anthropic API before saving.
 */
export const PUT = withAuth<SetKeyResponse, "/settings/api-keys/user">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        setApiKeyValidator
      );
      if (parseError) {
        return parseError;
      }

      // Validate key format and test it live
      const validation = await apiKeyService.validateClaudeApiKey(body.key);
      if (!validation.valid) {
        return badRequestResponse(validation.error ?? "Invalid API key");
      }

      await apiKeyService.setUserKey(user.id, body.key);

      return successResponse({
        isSet: true,
        lastFour: body.key.slice(-4),
      });
    } catch (error) {
      return errorResponse("Failed to set user API key", error);
    }
  }
);

/**
 * DELETE /settings/api-keys/user
 * Remove the user-level Claude API key override.
 */
export const DELETE = withAuth<{ deleted: true }, "/settings/api-keys/user">(
  async ({ user }) => {
    try {
      await apiKeyService.removeUserKey(user.id);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to remove user API key", error);
    }
  }
);
