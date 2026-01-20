import { analytics } from "@repo/analytics/server";
import type {
  DeletedObjectJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  UserJSON,
} from "@repo/auth/server";
import { organizationsService } from "../../organizations/service";
import { usersService } from "../../users/service";

export const handleUserCreated = async (data: UserJSON) => {
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
      const organization = await organizationsService.findByClerkId(
        membership.organization.id
      );

      if (organization) {
        await usersService.upsertByClerkId({
          clerkId: data.id,
          organizationId: organization.id,
          email,
          firstName: data.first_name,
          lastName: data.last_name,
          avatarUrl: data.image_url,
          phoneNumber: data.phone_numbers.at(0)?.phone_number,
        });
      }
    }
  }

  return new Response("User created", { status: 201 });
};

export const handleUserUpdated = (data: UserJSON) => {
  const email = data.email_addresses.at(0)?.email_address;
  const phoneNumber = data.phone_numbers.at(0)?.phone_number;

  analytics.identify({
    distinctId: data.id,
    properties: {
      email,
      firstName: data.first_name,
      lastName: data.last_name,
      createdAt: new Date(data.created_at),
      avatar: data.image_url,
      phoneNumber,
    },
  });

  analytics.capture({
    event: "User Updated",
    distinctId: data.id,
  });

  return new Response("User updated", { status: 204 });
};

export const handleUserDeleted = async (data: DeletedObjectJSON) => {
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

    await usersService.deactivateByClerkId(data.id);
  }

  return new Response("User deleted", { status: 204 });
};

export const handleOrganizationCreated = async (data: OrganizationJSON) => {
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

  await organizationsService.create({
    clerkId: data.id,
    name: data.name,
    slug: data.slug,
  });

  return new Response("Organization created", { status: 201 });
};

export const handleOrganizationUpdated = (data: OrganizationJSON) => {
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
};

export const handleOrganizationDeleted = async (data: DeletedObjectJSON) => {
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
};

export const handleOrganizationMembershipCreated = async (
  data: OrganizationMembershipJSON
) => {
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

  const organization = await organizationsService.findByClerkId(
    data.organization.id
  );

  if (organization && userId) {
    await usersService.upsertByClerkId({
      clerkId: userId,
      organizationId: organization.id,
      email: data.public_user_data.identifier, // TODO: Verify this is the correct email
      firstName: data.public_user_data.first_name,
      lastName: data.public_user_data.last_name,
      avatarUrl: data.public_user_data.image_url,
    });
  }

  return new Response("Organization membership created", { status: 201 });
};

export const handleOrganizationMembershipUpdated = (
  data: OrganizationMembershipJSON
) => {
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
};

export const handleOrganizationMembershipDeleted = async (
  data: OrganizationMembershipJSON
) => {
  const userId = data.public_user_data.user_id;

  analytics.capture({
    event: "Organization Member Deleted",
    distinctId: userId,
  });

  if (userId) {
    await usersService.deactivateByClerkId(userId);
  }

  return new Response("Organization membership deleted", { status: 204 });
};
