import type {
  CreateUserInput,
  UpdateUserProfileFromClerkInput,
} from "@repo/api/src/types/user";
import type { OrganizationMembershipJSON, UserJSON } from "@repo/auth/server";

/**
 * Basic email format check. Used to detect when Clerk's public_user_data.identifier
 * is a phone number rather than an email address.
 */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

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
 * Returns email as null if the identifier is not email-shaped (e.g., phone number),
 * signaling that the caller must fetch the real email from Clerk.
 *
 * @param data - Clerk organization membership webhook data
 * @param organizationId - Internal organization ID (not Clerk ID)
 * @returns CreateUserInput with email set to the identifier if email-shaped, or null if not
 */
export function mapMembershipToInput(
  data: OrganizationMembershipJSON,
  organizationId: string
): Omit<CreateUserInput, "email"> & { email: string | null } {
  const identifier = data.public_user_data.identifier;
  return {
    clerkId: data.public_user_data.user_id,
    organizationId,
    email: looksLikeEmail(identifier) ? identifier : null,
    firstName: data.public_user_data.first_name,
    lastName: data.public_user_data.last_name,
    avatarUrl: data.public_user_data.image_url,
  };
}
