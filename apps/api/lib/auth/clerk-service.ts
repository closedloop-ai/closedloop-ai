import "server-only";

import { clerkClient } from "@repo/auth/server";

/**
 * Clerk organization data returned from the API
 */
export type ClerkOrganization = {
  id: string;
  name: string;
  slug: string | null;
};

/**
 * Clerk user data returned from the API
 */
export type ClerkUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  phoneNumber: string | null;
};

/**
 * Clerk service - handles interactions with the Clerk SDK
 */
export const clerkService = {
  /**
   * Fetch an organization from Clerk by ID
   */
  async getOrganization(organizationId: string): Promise<ClerkOrganization> {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({
      organizationId,
    });

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
    };
  },

  async updateOrganization(
    organizationId: string,
    data: { slug?: string; name?: string }
  ): Promise<ClerkOrganization> {
    const client = await clerkClient();
    const org = await client.organizations.updateOrganization(organizationId, {
      ...(data.slug !== undefined && { slug: data.slug }),
      ...(data.name !== undefined && { name: data.name }),
    });

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
    };
  },

  /**
   * Fetch a user from Clerk by ID
   */
  async getUser(userId: string): Promise<ClerkUser> {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);

    // Get primary email
    const primaryEmail = user.emailAddresses.find(
      (email: { id: string; emailAddress: string }) =>
        email.id === user.primaryEmailAddressId
    );

    if (!primaryEmail) {
      throw new Error("User has no primary email address");
    }

    // Get primary phone number
    const primaryPhone = user.phoneNumbers.find(
      (phone: { id: string; phoneNumber: string }) =>
        phone.id === user.primaryPhoneNumberId
    );

    return {
      id: user.id,
      email: primaryEmail.emailAddress,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
      phoneNumber: primaryPhone?.phoneNumber ?? null,
    };
  },

  /**
   * Mint a real Clerk organization invitation for a single email (PRD-532
   * §5.4). On acceptance, Clerk fires `organizationMembership.created`, which
   * the auth webhook syncs into a durable MEMBER of the existing org — the
   * invitee joins the caller's org rather than creating a new org-of-one.
   *
   * `inviterUserId` is the inviter's Clerk user id so Clerk attributes the
   * invitation. Returns the Clerk invitation id.
   */
  async createOrganizationInvitation(params: {
    organizationId: string;
    emailAddress: string;
    role: string;
    inviterUserId: string;
  }): Promise<{ id: string }> {
    const client = await clerkClient();
    const invitation = await client.organizations.createOrganizationInvitation({
      organizationId: params.organizationId,
      emailAddress: params.emailAddress,
      role: params.role,
      inviterUserId: params.inviterUserId,
    });

    return { id: invitation.id };
  },

  /**
   * Fetch a user's organization membership role from Clerk.
   */
  async getOrganizationMembershipRole(
    organizationId: string,
    userId: string
  ): Promise<string | null> {
    const client = await clerkClient();
    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId,
        userId: [userId],
        limit: 1,
      });

    const membership = memberships.data[0];

    if (!membership) {
      return null;
    }

    return membership.role;
  },
};
