import type { Organization } from "@repo/api/src/types/organization";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { clerkService } from "@/lib/auth/clerk-service";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { getPrismaErrorCode, getPrismaP2002Target } from "@/lib/db-utils";
import {
  badRequestResponse,
  conflictResponse,
  forbiddenResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { organizationsService } from "./service";
import {
  type UpdateOrganizationBody,
  validateChangedOrganizationSlug,
} from "./validators";

const SLUG_UNAVAILABLE_MESSAGE = "Slug is unavailable";
const slugConflictTargetSchema = z.union([
  z.literal("Organization_slug_key"),
  z.tuple([z.literal("slug")]),
]);

export async function updateOrganizationForRoute({
  body,
  clerkUserId,
  id,
}: {
  body: UpdateOrganizationBody;
  clerkUserId: string;
  id: string;
}) {
  if (body.slug === undefined) {
    return updateOrganizationLocally(id, body, clerkUserId);
  }

  const currentOrganization = await organizationsService.findById(id);

  if (!currentOrganization) {
    return notFoundResponse("Organization");
  }

  if (body.slug === currentOrganization.slug) {
    return updateOrganizationWithUnchangedSlug({
      body,
      clerkUserId,
      currentOrganization,
      id,
    });
  }

  const parsedSlug = validateChangedOrganizationSlug(body.slug);

  if (!parsedSlug.success) {
    return badRequestResponse(parsedSlug.error);
  }

  const admin = await isOrgAdmin(currentOrganization.clerkId, clerkUserId);

  if (!admin) {
    return forbiddenResponse();
  }

  const existingOrganization = await organizationsService.findBySlug(
    parsedSlug.slug
  );

  if (existingOrganization && existingOrganization.id !== id) {
    return conflictResponse(SLUG_UNAVAILABLE_MESSAGE);
  }

  try {
    await clerkService.updateOrganization(currentOrganization.clerkId, {
      slug: parsedSlug.slug,
      ...(body.name !== undefined && { name: body.name }),
    });
  } catch (error) {
    log.error("org_slug_clerk_update_failed", {
      error: parseError(error),
      organizationId: id,
      clerkOrgId: currentOrganization.clerkId,
      slug: parsedSlug.slug,
      clerkStatus: isClerkApiError(error) ? error.status : undefined,
      clerkErrors: isClerkApiError(error)
        ? JSON.stringify(error.errors)
        : undefined,
    });
    if (isClerkConflictOrForbidden(error)) {
      return conflictResponse(SLUG_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }

  let organization: Organization | null;
  try {
    organization = await organizationsService.update(id, {
      ...body,
      slug: parsedSlug.slug,
    });
  } catch (error) {
    rollbackClerk(currentOrganization, body);
    if (isSlugConflictError(error)) {
      return conflictResponse(SLUG_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }

  if (!organization) {
    rollbackClerk(currentOrganization, body);
    return notFoundResponse("Organization");
  }

  return successResponse(organization);
}

function rollbackClerk(
  currentOrganization: Organization,
  body: UpdateOrganizationBody
): void {
  waitUntil(
    clerkService
      .updateOrganization(currentOrganization.clerkId, {
        slug: currentOrganization.slug,
        ...(body.name !== undefined && { name: currentOrganization.name }),
      })
      .catch((rollbackError) => {
        log.error("org_slug_db_fail_clerk_rollback_failed", {
          error: parseError(rollbackError),
          organizationId: currentOrganization.id,
          slug: currentOrganization.slug,
        });
      })
  );
}

function isClerkApiError(
  error: unknown
): error is { status: number; errors: unknown[] } {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  );
}

function isClerkConflictOrForbidden(error: unknown): boolean {
  if (!isClerkApiError(error)) {
    return false;
  }
  return error.status === 403 || error.status === 409;
}

async function updateOrganizationLocally(
  id: string,
  body: UpdateOrganizationBody,
  clerkUserId: string
) {
  const organization = await organizationsService.update(id, body);

  if (!organization) {
    return notFoundResponse("Organization");
  }

  if (body.name !== undefined && organization.clerkId) {
    try {
      await clerkService.updateOrganization(organization.clerkId, {
        name: body.name,
      });
    } catch (error) {
      log.error("org_name_clerk_sync_failed", {
        error: parseError(error),
        organizationId: id,
        clerkUserId,
      });
    }
  }

  return successResponse(organization);
}

async function updateOrganizationWithUnchangedSlug({
  body,
  clerkUserId,
  currentOrganization,
  id,
}: {
  body: UpdateOrganizationBody;
  clerkUserId: string;
  currentOrganization: Organization;
  id: string;
}) {
  const { slug: _slug, ...bodyWithoutSlug } = body;

  if (Object.keys(bodyWithoutSlug).length === 0) {
    return successResponse(currentOrganization);
  }

  const organization = await organizationsService.update(id, bodyWithoutSlug);

  if (!organization) {
    return notFoundResponse("Organization");
  }

  if (bodyWithoutSlug.name !== undefined && currentOrganization.clerkId) {
    try {
      await clerkService.updateOrganization(currentOrganization.clerkId, {
        name: bodyWithoutSlug.name,
      });
    } catch (error) {
      log.error("org_name_clerk_sync_failed", {
        error: parseError(error),
        organizationId: id,
        clerkUserId,
      });
    }
  }

  return successResponse(organization);
}

function isSlugConflictError(error: unknown): boolean {
  return (
    getPrismaErrorCode(error) === "P2002" &&
    slugConflictTargetSchema.safeParse(getPrismaP2002Target(error)).success
  );
}
