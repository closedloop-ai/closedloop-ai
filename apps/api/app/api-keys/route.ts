import type { ApiKey, CreateApiKeyResponse } from "@repo/api/src/types/api-key";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { apiKeysService } from "./service";
import { createApiKeyValidator } from "./validators";

export const GET = withAuth<ApiKey[], "/api-keys">(
  async ({ user, orgRole }) => {
    try {
      const keys = await apiKeysService.list(
        user.organizationId,
        user.id,
        orgRole ?? undefined
      );
      return successResponse(keys);
    } catch (error) {
      return errorResponse("Failed to fetch API keys", error);
    }
  }
);

export const POST = withAuth<CreateApiKeyResponse, "/api-keys">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createApiKeyValidator
      );
      if (parseError) {
        return parseError;
      }

      const input = {
        name: body.name,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        scopes: body.scopes,
      };

      const result = await apiKeysService.generate(
        user.organizationId,
        user.id,
        input
      );

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to create API key", error);
    }
  }
);
