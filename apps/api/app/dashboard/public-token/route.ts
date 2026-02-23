import type { PublicDashboardTokenResponse } from "@repo/api/src/types/dashboard";
import { env } from "@/env";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";
import { publicDashboardTokenService } from "../public-token-service";

const ADMIN_ROLES = new Set(["org:admin", "org:owner"]);

function buildPublicUrl(token: string): string {
  return `${env.NEXT_PUBLIC_APP_URL}/d/${token}`;
}

export const GET = withAuth<
  PublicDashboardTokenResponse,
  "/dashboard/public-token"
>(async ({ user, orgRole }) => {
  if (!(orgRole && ADMIN_ROLES.has(orgRole))) {
    return forbiddenResponse();
  }
  try {
    const token = await publicDashboardTokenService.getToken(
      user.organizationId
    );
    return successResponse({
      token,
      url: token ? buildPublicUrl(token) : null,
    });
  } catch (error) {
    return errorResponse("Failed to get public dashboard token", error);
  }
});

export const POST = withAuth<
  PublicDashboardTokenResponse,
  "/dashboard/public-token"
>(async ({ user, orgRole }) => {
  if (!(orgRole && ADMIN_ROLES.has(orgRole))) {
    return forbiddenResponse();
  }
  try {
    const token = await publicDashboardTokenService.generateToken(
      user.organizationId
    );
    return successResponse({
      token,
      url: buildPublicUrl(token),
    });
  } catch (error) {
    return errorResponse("Failed to generate public dashboard token", error);
  }
});

export const DELETE = withAuth<{ deleted: true }, "/dashboard/public-token">(
  async ({ user, orgRole }) => {
    if (!(orgRole && ADMIN_ROLES.has(orgRole))) {
      return forbiddenResponse();
    }
    try {
      await publicDashboardTokenService.revokeToken(user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to revoke public dashboard token", error);
    }
  }
);
