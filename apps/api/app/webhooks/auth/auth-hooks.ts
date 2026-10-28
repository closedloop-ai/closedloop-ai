import { POSTHOG_ORGANIZATION_GROUP_TYPE } from "@repo/analytics/feature-flags";
import { analytics } from "@repo/analytics/server";
import type { CreateUserInput } from "@repo/api/src/types/user";
import type {
  DeletedObjectJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  UserJSON,
} from "@repo/auth/server";
import { log } from "@repo/observability/log";
import {
  clerkService,
  invalidateUserExternalAccountProviders,
} from "@/lib/auth/clerk-service";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { revokeDocSyncAccess } from "../../doc-sync/internal/revoke";
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

      // ISS-7132: `user.created` carries its own `updated_at`, so this mirror
      // write is orderable and goes through the guard (review, whitlockk). A
      // replayed creation would otherwise revert what a newer `user.updated`
      // already wrote AND erase the watermark, reopening the stale-update path
      // the guard closes. A null stamp means the payload carried no usable one,
      // which this path can express: the write stays ungated, exactly as it was
      // before the guard, rather than dropping the row.
      await usersService.upsertByClerkIdAndOrg(
        mapClerkUserToInput(data, organization.id),
        clerkMirrorStamp(data.updated_at)
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

  // ISS-10335: linking or unlinking an OAuth account changes the Clerk user, so
  // this delivery is the signal that a memoized provider list is stale. It runs
  // ahead of the `updated_at` guard below, which orders the DB mirror write and
  // says nothing about a cache. Best-effort: this instance is rarely the one
  // holding the memo, so the memo's TTL is what actually bounds staleness.
  invalidateUserExternalAccountProviders(data.id);

  const clerkUpdatedAt = clerkMirrorStamp(data.updated_at);
  if (!clerkUpdatedAt) {
    log.warn("[webhook/auth] Skipped user mirror write: unusable updated_at", {
      clerkId: data.id,
      updatedAt: data.updated_at,
    });
    return new Response(null, { status: 204 });
  }

  const rowsWritten = await usersService.updateByClerkId(
    data.id,
    updateInput,
    clerkUpdatedAt
  );

  if (rowsWritten === 0) {
    // Two causes, indistinguishable from here: the ISS-7132 guard rejected a
    // replayed or out-of-order delivery, or this Clerk user has no mirrored row
    // in any organization yet. Neither is worth failing the delivery over — a
    // non-2xx would only make Svix redeliver the same payload.
    log.info("[webhook/auth] user.updated mirrored no rows", {
      clerkId: data.id,
      clerkUpdatedAt: data.updated_at,
    });
  }

  // Body-less on purpose, here and at every other 204 below: `new Response(body,
  // { status: 204 })` THROWS in undici, which is the `Response` the Next.js Node
  // runtime provides. POST awaits these handlers, so that throw became a 500
  // AFTER the write had landed and Svix redelivered a payload we had already
  // applied — the exact retry storm this file's guard exists to survive
  // (review, whitlockk).
  return new Response(null, { status: 204 });
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

    const deactivated = await usersService.deactivateAllByClerkId(data.id);
    await Promise.all(
      deactivated.map(({ id }) => revokeDocSyncAccess({ userId: id }))
    );
  }

  return new Response(null, { status: 204 });
}

export async function handleOrganizationCreated(
  data: OrganizationJSON
): Promise<Response> {
  analytics.groupIdentify({
    groupKey: data.id,
    groupType: POSTHOG_ORGANIZATION_GROUP_TYPE,
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
  await syncOrganizationFromClerk(data, "organization.created");

  return new Response("Organization created", { status: 201 });
}

export async function handleOrganizationUpdated(
  data: OrganizationJSON
): Promise<Response> {
  analytics.groupIdentify({
    groupKey: data.id,
    groupType: POSTHOG_ORGANIZATION_GROUP_TYPE,
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

  await organizationsService.findOrCreateByClerkId(data.id, {
    name: data.name,
    slug: data.slug,
  });
  await syncOrganizationFromClerk(data, "organization.updated");

  return new Response(null, { status: 204 });
}

export async function handleOrganizationDeleted(
  data: DeletedObjectJSON
): Promise<Response> {
  analytics.groupIdentify({
    groupKey: data.id ?? "<unknown>",
    groupType: POSTHOG_ORGANIZATION_GROUP_TYPE,
    properties: {
      slug: data.slug,
    },
  });

  analytics.capture({
    event: "Organization Deleted",
    distinctId: data.id ?? "<unknown>",
  });

  if (data.id) {
    const organization = await organizationsService.deactivateByClerkId(
      data.id
    );
    if (organization) {
      await revokeDocSyncAccess({ orgId: organization.id });
    }
  }

  return new Response(null, { status: 204 });
}

export async function handleOrganizationMembershipCreated(
  data: OrganizationMembershipJSON
): Promise<Response> {
  const userId = data.public_user_data.user_id;

  analytics.groupIdentify({
    groupKey: data.organization.id,
    groupType: POSTHOG_ORGANIZATION_GROUP_TYPE,
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
    groupType: POSTHOG_ORGANIZATION_GROUP_TYPE,
    distinctId: userId,
  });

  analytics.capture({
    event: "Organization Member Updated",
    distinctId: userId,
  });

  // TODO: eventually we'll need to update the user's role and permissions here.

  return new Response(null, { status: 204 });
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
      const deactivatedId = await deactivateMember(userId, organization.id);
      if (deactivatedId !== null) {
        await revokeDocSyncAccess({ userId: deactivatedId });
      }
    }
  }

  return new Response(null, { status: 204 });
}

/**
 * Mirror a Clerk organization payload into the DB, gated on the payload's own
 * `updated_at` (ISS-7132). Shared by `organization.created` and
 * `organization.updated` so the two cannot drift into different orderings of
 * the same two columns — a replayed `organization.created` is as capable of
 * reverting a rename as a stale `organization.updated`.
 *
 * The caller runs `findOrCreateByClerkId` first, so the row is known to exist
 * and a zero row count is unambiguously the guard rejecting a replayed or
 * out-of-order delivery. Logged, not raised: a rejected delivery is the guard
 * working, and Svix must still see a 2xx or it will keep redelivering.
 */
async function syncOrganizationFromClerk(
  data: OrganizationJSON,
  eventType: "organization.created" | "organization.updated"
): Promise<void> {
  const clerkUpdatedAt = clerkMirrorStamp(data.updated_at);
  if (!clerkUpdatedAt) {
    log.warn(
      "[webhook/auth] Skipped organization mirror write: unusable updated_at",
      { eventType, clerkOrgId: data.id, updatedAt: data.updated_at }
    );
    return;
  }

  const rowsWritten = await organizationsService.updateByClerkId(
    data.id,
    { name: data.name, slug: data.slug },
    clerkUpdatedAt
  );

  if (rowsWritten === 0) {
    log.info("[webhook/auth] Ignored stale organization delivery", {
      eventType,
      clerkOrgId: data.id,
      clerkUpdatedAt: data.updated_at,
    });
  }
}

/**
 * The `Date` the ISS-7132 guard orders a delivery by, or null when the payload
 * carries no usable `updated_at`. The route verifies the Svix signature and
 * nothing about the body shape, so the field is typed as a number but not known
 * to be one — and an Invalid Date makes Prisma throw, which POST turns into a
 * 500 and Svix then redelivers forever a payload that can never succeed. That
 * is the retry storm the guard exists to survive, so it is not worth risking to
 * order one delivery Clerk re-emits on the next change.
 */
function clerkMirrorStamp(updatedAt: number): Date | null {
  const stamp = new Date(updatedAt);
  return Number.isNaN(stamp.getTime()) ? null : stamp;
}

/** The deactivated row's id, or null when the member has no row in this organization. */
async function deactivateMember(
  clerkUserId: string,
  organizationId: string
): Promise<string | null> {
  try {
    const { id } = await usersService.deactivateByClerkIdAndOrg(
      clerkUserId,
      organizationId
    );
    return id;
  } catch (error) {
    // P2025: user record not found — already gone or never created
    if (getPrismaErrorCode(error) === "P2025") {
      log.info("User not found for deactivation, skipping", {
        clerkId: clerkUserId,
        organizationId,
      });
      return null;
    }
    throw error;
  }
}
