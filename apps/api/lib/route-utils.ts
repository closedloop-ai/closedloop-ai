import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { auth } from "@repo/auth/server";
import { database } from "@repo/database";
import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * Standard route params type for [id] routes.
 */
export type RouteParams<T extends string = "id"> = {
  params: Promise<{ [K in T]: string }>;
};

/**
 * Authenticated user context returned by getAuthContext.
 */
export type AuthContext = {
  userId: string;
  organizationId: string;
  clerkUserId: string;
};

/**
 * Get the authenticated user context from the request.
 * Returns the user's ID, organization ID, and Clerk user ID.
 * Returns null if not authenticated or user not found in database.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    return null;
  }

  const user = await database.user.findUnique({
    where: { clerkUserId },
    select: { id: true, organizationId: true, clerkUserId: true },
  });

  if (!user?.clerkUserId) {
    return null;
  }

  return {
    userId: user.id,
    organizationId: user.organizationId,
    clerkUserId: user.clerkUserId,
  };
}

/**
 * Create an unauthorized response (401).
 */
export function unauthorizedResponse(): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure("Unauthorized"), { status: 401 });
}

/**
 * Create a forbidden response (403).
 */
export function forbiddenResponse(): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure("Forbidden"), { status: 403 });
}

// =============================================================================
// RESOURCE ACCESS VERIFICATION
// =============================================================================

/**
 * Verify that a project belongs to the specified organization.
 */
export async function verifyProjectAccess(
  projectId: string,
  organizationId: string
): Promise<{ exists: boolean; hasAccess: boolean }> {
  const project = await database.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });

  if (!project) {
    return { exists: false, hasAccess: false };
  }

  return {
    exists: true,
    hasAccess: project.organizationId === organizationId,
  };
}

/**
 * Verify that a workstream belongs to the specified organization (via project).
 */
export async function verifyWorkstreamAccess(
  workstreamId: string,
  organizationId: string
): Promise<{ exists: boolean; hasAccess: boolean }> {
  const workstream = await database.workstream.findUnique({
    where: { id: workstreamId },
    include: {
      project: {
        select: { organizationId: true },
      },
    },
  });

  if (!workstream) {
    return { exists: false, hasAccess: false };
  }

  return {
    exists: true,
    hasAccess: workstream.project.organizationId === organizationId,
  };
}

/**
 * Verify that an artifact belongs to the specified organization (via project).
 */
export async function verifyArtifactAccess(
  artifactId: string,
  organizationId: string
): Promise<{ exists: boolean; hasAccess: boolean }> {
  const artifact = await database.artifact.findUnique({
    where: { id: artifactId },
    include: {
      project: {
        select: { organizationId: true },
      },
      workstream: {
        include: {
          project: {
            select: { organizationId: true },
          },
        },
      },
    },
  });

  if (!artifact) {
    return { exists: false, hasAccess: false };
  }

  // Check org via project (direct) or workstream's project
  const artifactOrgId =
    artifact.project?.organizationId ||
    artifact.workstream?.project?.organizationId;

  return {
    exists: true,
    hasAccess: artifactOrgId === organizationId,
  };
}

/**
 * Verify that a user belongs to the specified organization.
 */
export async function verifyUserAccess(
  userId: string,
  organizationId: string
): Promise<{ exists: boolean; hasAccess: boolean }> {
  const user = await database.user.findUnique({
    where: { id: userId },
    select: { organizationId: true },
  });

  if (!user) {
    return { exists: false, hasAccess: false };
  }

  return {
    exists: true,
    hasAccess: user.organizationId === organizationId,
  };
}

/**
 * Parse and validate request body against a zod schema.
 * Returns the validated data or a NextResponse error.
 */
export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<z.infer<T> | NextResponse<ApiResult<never>>> {
  try {
    const rawBody = await request.json();
    const parseResult = schema.safeParse(rawBody);

    if (!parseResult.success) {
      const errorMessage = parseResult.error.issues
        .map((issue) => issue.message)
        .join(", ");
      return NextResponse.json(failure(errorMessage), { status: 400 });
    }

    return parseResult.data;
  } catch {
    return NextResponse.json(failure("Invalid JSON body"), { status: 400 });
  }
}

/**
 * Check if the result of parseBody is an error response.
 */
export function isErrorResponse<T>(
  result: T | NextResponse<ApiResult<never>>
): result is NextResponse<ApiResult<never>> {
  return result instanceof NextResponse;
}

/**
 * Create a standardized error response with logging.
 */
export function errorResponse(
  message: string,
  error: unknown,
  status = 500
): NextResponse<ApiResult<never>> {
  console.error(`${message}:`, error);
  return NextResponse.json(failure(message), { status });
}

/**
 * Create a success response.
 */
export function successResponse<T>(data: T): NextResponse<ApiResult<T>> {
  return NextResponse.json(success(data));
}

/**
 * Create a not found response.
 */
export function notFoundResponse(
  entity: string
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(`${entity} not found`), { status: 404 });
}

/**
 * Create a standard delete success response.
 */
export function deleteResponse(): NextResponse<ApiResult<{ deleted: true }>> {
  return NextResponse.json(success({ deleted: true }));
}
