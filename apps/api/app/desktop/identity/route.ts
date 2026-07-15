import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { desktopIdentityService } from "./service";

/**
 * GET /desktop/identity — display identity (name, email, organization name) for
 * the authenticated caller (FEA-2219). Reachable by the first-party desktop
 * session token via {@link withAnyAuth}; the desktop Account tab renders it in
 * place of the raw user/org ids the session carries.
 */
export const GET = withAnyAuth<DesktopIdentity>(async ({ user }) => {
  try {
    const identity = await desktopIdentityService.get(
      user.id,
      user.organizationId
    );
    if (!identity) {
      return notFoundResponse("User");
    }
    return successResponse(identity);
  } catch (error) {
    return errorResponse("Failed to fetch identity", error);
  }
});
