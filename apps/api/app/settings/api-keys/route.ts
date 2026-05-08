import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { apiKeyService } from "../api-key-service";

type ApiKeyInfoResponse = {
  org: { isSet: boolean; lastFour: string | null; setAt: string | null };
  user: { isSet: boolean; lastFour: string | null; setAt: string | null };
};

/**
 * GET /settings/api-keys
 * Returns masked key info for both org and user levels.
 */
export const GET = withAuth<ApiKeyInfoResponse, "/settings/api-keys">(
  async ({ user }) => {
    try {
      const [orgInfo, userInfo] = await Promise.all([
        apiKeyService.getOrgKeyInfo(user.organizationId),
        apiKeyService.getUserKeyInfo(user.id),
      ]);

      return successResponse({
        org: {
          ...orgInfo,
          setAt: orgInfo.setAt ? orgInfo.setAt.toISOString() : null,
        },
        user: {
          ...userInfo,
          setAt: userInfo.setAt ? userInfo.setAt.toISOString() : null,
        },
      });
    } catch (error) {
      return errorResponse("Failed to fetch API key info", error);
    }
  }
);
