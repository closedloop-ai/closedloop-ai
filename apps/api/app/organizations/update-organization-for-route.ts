import type { Organization } from "@repo/api/src/types/organization";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { clerkService } from "@/lib/auth/clerk-service";
import { getOrgAdminStatus } from "@/lib/auth/org-admin";
import { orgAdminDenialResponse } from "@/lib/auth/org-admin-denial";
import { getPrismaErrorCode, matchesPrismaP2002Target } from "@/lib/db-utils";
import {
  type OrgAdminDenialContext,
  OrgAdminGate,
  reportOrgAdminDenial,
} from "@/lib/observability/admin-denial-telemetry";
import {
  badRequestResponse,
  conflictResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { organizationsService } from "./service";
import {
  type UpdateOrganizationBody,
  validateChangedOrganizationSlug,
} from "./validators";

const SLUG_UNAVAILABLE_MESSAGE = "Slug is unavailable";
// ISS-8804: `organizations_slug_key` is the index Postgres actually reports —
// the model is `@@map("organizations")`, so the previous `Organization_slug_key`
// literal (the UN-MAPPED model name) could never match a real violation and is
// deleted rather than kept beside its replacement. The tuple stays: it is the
// field-array shape an adapter that reports columns rather than an index name
// would send.
const slugConflictTargetSchema = z.union([
  z.literal("organizations_slug_key"),
  z.tuple([z.literal("slug")]),
]);

/**
 * `clerkOrgId` is the authenticated caller's own Clerk org, taken from the auth
 * context — not from the organization row `id` resolves to. It is the single
 * answer to both "whose admin role is being checked" and "which Clerk org does
 * this request mutate", on every branch below. Sourcing the decision from the
 * row instead would ask "is the caller an admin of the org the caller named",
 * which is the question no authorization check may answer; sourcing only some
 * of the writes from it would let one request straddle two Clerk orgs.
 */
export async function updateOrganizationForRoute({
  body,
  clerkOrgId,
  clerkUserId,
  id,
}: {
  body: UpdateOrganizationBody;
  clerkOrgId: string;
  clerkUserId: string;
  id: string;
}) {
  // Enforce here before any persistence branch so no admin-only field can be
  // set through the non-slug local-update path a member can otherwise reach.
  const adminOnlyFieldDenial = await enforceAdminOnlyFieldGate({
    body,
    clerkOrgId,
    clerkUserId,
    id,
  });
  if (adminOnlyFieldDenial) {
    return adminOnlyFieldDenial;
  }

  if (body.slug === undefined) {
    return updateOrganizationLocally({ body, clerkOrgId, clerkUserId, id });
  }

  // The unchanged-slug branch below echoes this object back as the response
  // body, so this call site needs the payload read, not the identity one.
  const currentOrganization = await organizationsService.findDetailById(id);

  if (!currentOrganization) {
    return notFoundResponse("Organization");
  }

  if (body.slug === currentOrganization.slug) {
    return updateOrganizationWithUnchangedSlug({
      body,
      clerkOrgId,
      clerkUserId,
      currentOrganization,
      id,
    });
  }

  const parsedSlug = validateChangedOrganizationSlug(body.slug);

  if (!parsedSlug.success) {
    return badRequestResponse(parsedSlug.error);
  }

  const slugAdminStatus = await getOrgAdminStatus(clerkOrgId, clerkUserId);

  if (!slugAdminStatus.isAdmin) {
    return denyNonAdmin({
      clerkOrgId,
      clerkUserId,
      fields: ["slug"],
      gate: OrgAdminGate.SlugChange,
      reason: slugAdminStatus.reason,
    });
  }

  const existingOrganization = await organizationsService.findBySlug(
    parsedSlug.slug
  );

  if (existingOrganization && existingOrganization.id !== id) {
    return conflictResponse(SLUG_UNAVAILABLE_MESSAGE);
  }

  try {
    await clerkService.updateOrganization(clerkOrgId, {
      slug: parsedSlug.slug,
      ...(body.name !== undefined && { name: body.name }),
    });
  } catch (error) {
    log.error("org_slug_clerk_update_failed", {
      error: parseError(error),
      organizationId: id,
      clerkOrgId,
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
    rollbackClerk(clerkOrgId, currentOrganization, body);
    if (isSlugConflictError(error)) {
      return conflictResponse(SLUG_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }

  if (!organization) {
    rollbackClerk(clerkOrgId, currentOrganization, body);
    return notFoundResponse("Organization");
  }

  return successResponse(organization);
}

// Takes the same `clerkOrgId` the forward write used, so the rollback can never
// target a different Clerk org than the one it is undoing.
function rollbackClerk(
  clerkOrgId: string,
  currentOrganization: Organization,
  body: UpdateOrganizationBody
): void {
  waitUntil(
    clerkService
      .updateOrganization(clerkOrgId, {
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

async function updateOrganizationLocally({
  body,
  clerkOrgId,
  clerkUserId,
  id,
}: {
  body: UpdateOrganizationBody;
  clerkOrgId: string;
  clerkUserId: string;
  id: string;
}) {
  const organization = await organizationsService.update(id, body);

  if (!organization) {
    return notFoundResponse("Organization");
  }

  if (body.name !== undefined) {
    try {
      await clerkService.updateOrganization(clerkOrgId, {
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
  clerkOrgId,
  clerkUserId,
  currentOrganization,
  id,
}: {
  body: UpdateOrganizationBody;
  clerkOrgId: string;
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

  if (bodyWithoutSlug.name !== undefined) {
    try {
      await clerkService.updateOrganization(clerkOrgId, {
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
    matchesPrismaP2002Target(
      error,
      (target) => slugConflictTargetSchema.safeParse(target).success
    )
  );
}

async function enforceAdminOnlyFieldGate({
  body,
  clerkOrgId,
  clerkUserId,
  id,
}: {
  body: UpdateOrganizationBody;
  clerkOrgId: string;
  clerkUserId: string;
  id: string;
}) {
  const deniedFields = ADMIN_ONLY_ORGANIZATION_FIELDS.filter(
    (field) => body[field] !== undefined
  );
  if (deniedFields.length === 0) {
    return null;
  }
  const organization = await organizationsService.findById(id);
  if (!organization) {
    return notFoundResponse("Organization");
  }
  const adminStatus = await getOrgAdminStatus(clerkOrgId, clerkUserId);
  if (!adminStatus.isAdmin) {
    return denyNonAdmin({
      clerkOrgId,
      clerkUserId,
      fields: deniedFields,
      gate: OrgAdminGate.AdminOnlyField,
      reason: adminStatus.reason,
    });
  }
  return null;
}

/**
 * Single denial exit for both gates, so they cannot drift into reporting
 * different shapes. Emission is bounded in {@link reportOrgAdminDenial}; the
 * 403 is not, so a throttled emission can never change who is refused.
 *
 * NO FLUSH HERE — #5485 review (whitlockk). `withAuth` calls `logRequestCompleted`
 * in its `finally`, which calls `scheduleLogFlush` once this handler returns,
 * so a flush on this line was a second `log.flush` and, with tracing on, a
 * second span-flush callback on every denial. `[id]/admin-denial-flush.test.ts`
 * pins the single terminal flush through the REAL wrapper.
 */
function denyNonAdmin(context: OrgAdminDenialContext) {
  reportOrgAdminDenial(context);
  return orgAdminDenialResponse(context.reason);
}

// Iterated, not tested one-by-one, so the gate's trigger and the signal's
// `fields` cannot describe different sets.
const ADMIN_ONLY_ORGANIZATION_FIELDS = [
  "searchIncludeTranscripts",
  "settings",
] as const satisfies readonly (keyof UpdateOrganizationBody)[];
