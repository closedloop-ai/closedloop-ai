import { analytics } from "@repo/analytics/server";
import type { CreateUserInput } from "@repo/api/src/types/organization";
import type {
  DeletedObjectJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  UserJSON,
} from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";
import { organizationsService } from "../../organizations/service";
import { usersService } from "../../users/service";
import {
  mapClerkUserToInput,
  mapClerkUserToUpdateInput,
  mapMembershipToInput,
} from "./webhook-mappers";

export async function handleUserCreated(data: UserJSON): Promise<Response> {
  const email = data.email_addresses.at(0)?.email_address;

  analytics.identify({
    distinctId: data.id,
    properties: {
      email,
      firstName: data.first_name,
      lastName: data.last_name,
      createdAt: new Date(data.created_at),
      avatar: data.image_url,
    },
  });

  analytics.capture({
    event: "User Created",
    distinctId: data.id,
  });

  if (email) {
    for (const membership of data.organization_memberships ?? []) {
      const organization = await organizationsService.findOrCreateByClerkId(
        membership.organization.id,
        membership.organization
      );

      await usersService.upsertByClerkIdAndOrg(
        mapClerkUserToInput(data, organization.id)
      );
    }
  }

  return new Response("User created", { status: 201 });
}

export async function handleUserUpdated(data: UserJSON): Promise<Response> {
  const updateInput = mapClerkUserToUpdateInput(data);

  analytics.identify({
    distinctId: data.id,
    properties: {
      email: updateInput.email,
      firstName: updateInput.firstName,
      lastName: updateInput.lastName,
      createdAt: new Date(data.created_at),
      avatar: updateInput.avatarUrl,
      phoneNumber: updateInput.phoneNumber,
    },
  });

  analytics.capture({
    event: "User Updated",
    distinctId: data.id,
  });

  await usersService.updateByClerkId(data.id, updateInput);

  return new Response("User updated", { status: 204 });
}

export async function handleUserDeleted(
  data: DeletedObjectJSON
): Promise<Response> {
  if (data.id) {
    analytics.identify({
      distinctId: data.id,
      properties: {
        deleted: new Date(),
      },
    });

    analytics.capture({
      event: "User Deleted",
      distinctId: data.id,
    });

    await usersService.deactivateAllByClerkId(data.id);
  }

  return new Response("User deleted", { status: 204 });
}

export async function handleOrganizationCreated(
  data: OrganizationJSON
): Promise<Response> {
  analytics.groupIdentify({
    groupKey: data.id,
    groupType: "company",
    distinctId: data.created_by,
    properties: {
      name: data.name,
      avatar: data.image_url,
    },
  });

  if (data.created_by) {
    analytics.capture({
      event: "Organization Created",
      distinctId: data.created_by,
    });
  }

  await organizationsService.findOrCreateByClerkId(data.id, {
    name: data.name,
    slug: data.slug,
  });
  // Update name/slug since the organization.created event is the authoritative source
  await organizationsService.updateByClerkId(data.id, {
    name: data.name,
    slug: data.slug,
  });

  return new Response("Organization created", { status: 201 });
}

export function handleOrganizationUpdated(data: OrganizationJSON): Response {
  analytics.groupIdentify({
    groupKey: data.id,
    groupType: "company",
    distinctId: data.created_by,
    properties: {
      name: data.name,
      avatar: data.image_url,
    },
  });

  if (data.created_by) {
    analytics.capture({
      event: "Organization Updated",
      distinctId: data.created_by,
    });
  }

  return new Response("Organization updated", { status: 204 });
}

export async function handleOrganizationDeleted(
  data: DeletedObjectJSON
): Promise<Response> {
  analytics.groupIdentify({
    groupKey: data.id ?? "<unknown>",
    groupType: "company",
    properties: {
      slug: data.slug,
    },
  });

  analytics.capture({
    event: "Organization Deleted",
    distinctId: data.id ?? "<unknown>",
  });

  if (data.id) {
    await organizationsService.deactivateByClerkId(data.id);
  }

  return new Response("Organization deleted", { status: 204 });
}

export async function handleOrganizationMembershipCreated(
  data: OrganizationMembershipJSON
): Promise<Response> {
  const userId = data.public_user_data.user_id;

  analytics.groupIdentify({
    groupKey: data.organization.id,
    groupType: "company",
    distinctId: userId,
  });

  analytics.capture({
    event: "Organization Member Created",
    distinctId: userId,
  });

  const organization = await organizationsService.findOrCreateByClerkId(
    data.organization.id,
    data.organization
  );

  if (userId) {
    const mapped = mapMembershipToInput(data, organization.id);

    if (mapped.email) {
      // Fast path: identifier is email-shaped, use directly (no Clerk API call)
      await usersService.upsertByClerkIdAndOrg(mapped as CreateUserInput);
    } else {
      // Identifier is not an email (likely phone number).
      // Fetch full user from Clerk to get the actual email address.
      log.info(
        "Membership identifier is not email-shaped, fetching from Clerk",
        {
          userId,
          identifier: data.public_user_data.identifier,
        }
      );
      const clerkUser = await clerkService.getUser(userId);
      await usersService.upsertByClerkIdAndOrg({
        ...mapped,
        email: clerkUser.email,
        phoneNumber: clerkUser.phoneNumber,
      });
    }
  }

  return new Response("Organization membership created", { status: 201 });
}

export function handleOrganizationMembershipUpdated(
  data: OrganizationMembershipJSON
): Response {
  const userId = data.public_user_data.user_id;

  analytics.groupIdentify({
    groupKey: data.organization.id,
    groupType: "company",
    distinctId: userId,
  });

  analytics.capture({
    event: "Organization Member Updated",
    distinctId: userId,
  });

  // TODO: eventually we'll need to update the user's role and permissions here.

  return new Response("Organization membership updated", { status: 204 });
}

export async function handleOrganizationMembershipDeleted(
  data: OrganizationMembershipJSON
): Promise<Response> {
  const userId = data.public_user_data.user_id;

  analytics.capture({
    event: "Organization Member Deleted",
    distinctId: userId,
  });

  if (userId) {
    const organization = await organizationsService.findByClerkId(
      data.organization.id
    );

    if (organization) {
      try {
        await usersService.deactivateByClerkIdAndOrg(userId, organization.id);
      } catch (error) {
        // P2025: user record not found — already gone or never created
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code: string }).code === "P2025"
        ) {
          log.info("User not found for deactivation, skipping", {
            clerkId: userId,
            organizationId: organization.id,
          });
        } else {
          throw error;
        }
      }
    }
  }

  return new Response("Organization membership deleted", { status: 204 });
}
