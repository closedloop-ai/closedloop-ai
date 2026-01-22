import type { ApiResult } from "@repo/api/src/types/common";
import { auth, currentUser } from "@repo/auth/server";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { organizationsService } from "../../organizations/service";
import { usersService } from "../../users/service";

/**
 * POST /auth/sync - Sync current Clerk user to database (for local dev without webhooks)
 *
 * Creates the user and organization if they don't exist.
 * Safe to call multiple times - will not duplicate data.
 */
export async function POST(): Promise<
  NextResponse<
    ApiResult<{ synced: boolean; userId: string; organizationId: string }>
  >
> {
  try {
    const { userId: clerkUserId, orgId: clerkOrgId } = await auth();

    if (!clerkUserId) {
      return unauthorizedResponse();
    }

    // Get full user details from Clerk
    const clerkUser = await currentUser();
    if (!clerkUser) {
      return unauthorizedResponse();
    }

    // Check if user already exists
    let user = await usersService.findByClerkId(clerkUserId);

    if (user) {
      return successResponse({
        synced: false,
        userId: user.id,
        organizationId: user.organizationId,
      });
    }

    // Need to create user - first ensure org exists
    let organizationId: string;

    if (clerkOrgId) {
      // User is in a Clerk organization
      let org = await organizationsService.findByClerkId(clerkOrgId);

      if (!org) {
        // Create organization from Clerk org
        org = await organizationsService.create({
          clerkId: clerkOrgId,
          name: "Organization",
          slug: clerkOrgId.toLowerCase().replace(/[^a-z0-9]/g, "-"),
        });
      }
      organizationId = org.id;
    } else {
      // Personal account - create personal org
      const personalOrgClerkId = `personal_${clerkUserId}`;
      let org = await organizationsService.findByClerkId(personalOrgClerkId);

      if (!org) {
        org = await organizationsService.create({
          clerkId: personalOrgClerkId,
          name: `${clerkUser.firstName || "User"}'s Workspace`,
          slug: `personal-${clerkUserId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
        });
      }
      organizationId = org.id;
    }

    // Create user
    user = await usersService.create({
      clerkId: clerkUserId,
      organizationId,
      email: clerkUser.emailAddresses[0]?.emailAddress || "",
      firstName: clerkUser.firstName,
      lastName: clerkUser.lastName,
      avatarUrl: clerkUser.imageUrl,
    });

    return successResponse({
      synced: true,
      userId: user.id,
      organizationId: user.organizationId,
    });
  } catch (error) {
    return errorResponse("Failed to sync user", error);
  }
}
