import type {
  CreateUserInput,
  UpdateUserProfileFromClerkInput,
} from "@repo/api/src/types/organization";
import type { OrganizationMembershipJSON, UserJSON } from "@repo/auth/server";

/**
 * Maps a Clerk UserJSON webhook payload to CreateUserInput for database upsert.
 *
 * @param data - Clerk user webhook data
 * @param organizationId - Internal organization ID (not Clerk ID)
 * @returns CreateUserInput for usersService.upsertByClerkIdAndOrg
 */
export function mapClerkUserToInput(
  data: UserJSON,
  organizationId: string
): CreateUserInput {
  const email = data.email_addresses.at(0)?.email_address;

  if (!email) {
    throw new Error("User must have at least one email address");
  }

  return {
    clerkId: data.id,
    organizationId,
    email,
    firstName: data.first_name,
    lastName: data.last_name,
    avatarUrl: data.image_url,
    phoneNumber: data.phone_numbers.at(0)?.phone_number,
  };
}

/**
 * Maps a Clerk UserJSON webhook payload to UpdateUserProfileFromClerkInput for profile updates.
 *
 * @param data - Clerk user webhook data
 * @returns UpdateUserProfileFromClerkInput for usersService.updateByClerkId
 */
export function mapClerkUserToUpdateInput(
  data: UserJSON
): UpdateUserProfileFromClerkInput {
  return {
    email: data.email_addresses.at(0)?.email_address,
    firstName: data.first_name,
    lastName: data.last_name,
    avatarUrl: data.image_url,
    phoneNumber: data.phone_numbers.at(0)?.phone_number ?? null,
  };
}

/**
 * Maps a Clerk OrganizationMembershipJSON webhook payload to CreateUserInput for database upsert.
 *
 * @param data - Clerk organization membership webhook data
 * @param organizationId - Internal organization ID (not Clerk ID)
 * @returns CreateUserInput for usersService.upsertByClerkIdAndOrg
 */
export function mapMembershipToInput(
  data: OrganizationMembershipJSON,
  organizationId: string
): CreateUserInput {
  return {
    clerkId: data.public_user_data.user_id,
    organizationId,
    email: data.public_user_data.identifier,
    firstName: data.public_user_data.first_name,
    lastName: data.public_user_data.last_name,
    avatarUrl: data.public_user_data.image_url,
  };
}
