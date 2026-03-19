import "server-only";

import { EntityType } from "@repo/api/src/types/entity-link";
import { TYPED_SLUG_PATTERN } from "@repo/api/src/types/slug";
import { withDb } from "@repo/database";
import { z } from "zod";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Legacy nanoid slugs: exactly 14 alphanumeric characters */
const NANOID_SLUG_REGEX = /^[A-Za-z0-9_-]{14}$/;

/**
 * Returns true if the string is a valid UUID (v4/v7 format).
 * Everything that is not a UUID is treated as a slug candidate.
 */
export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Zod schema that accepts either a UUID or a typed/nanoid slug.
 * Use in place of `z.uuid()` for fields that reference slug-capable entities.
 *
 * Accepted formats:
 * - UUID: `550e8400-e29b-41d4-a716-446655440000`
 * - Typed slug: `PRD-42`, `FEAT-1`, `PROJ-123`, `WORK-5`, `PLAN-7`
 * - Legacy nanoid slug: 14-character alphanumeric string
 */
export function uuidOrSlug() {
  return z
    .string()
    .min(1, "ID or slug is required")
    .refine(
      (val) =>
        UUID_REGEX.test(val) ||
        TYPED_SLUG_PATTERN.test(val) ||
        NANOID_SLUG_REGEX.test(val),
      {
        message:
          "Must be a UUID (e.g. 550e8400-e29b-...) or a slug (e.g. PRD-42)",
      }
    );
}

// ---------------------------------------------------------------------------
// UUID-only resolvers — return the UUID string for filter/body params
// ---------------------------------------------------------------------------

export async function resolveArtifactId(
  id: string,
  organizationId: string
): Promise<string | null> {
  if (isUuid(id)) {
    return id;
  }
  const row = await withDb((db) =>
    db.artifact.findUnique({
      where: { organizationId_slug: { organizationId, slug: id } },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

export async function resolveIssueId(
  id: string,
  organizationId: string
): Promise<string | null> {
  if (isUuid(id)) {
    return id;
  }
  const row = await withDb((db) =>
    db.issue.findUnique({
      where: { organizationId_slug: { organizationId, slug: id } },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

export async function resolveProjectId(
  id: string,
  organizationId: string
): Promise<string | null> {
  if (isUuid(id)) {
    return id;
  }
  const row = await withDb((db) =>
    db.project.findUnique({
      where: { organizationId_slug: { organizationId, slug: id } },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

export async function resolveWorkstreamId(
  id: string,
  organizationId: string
): Promise<string | null> {
  if (isUuid(id)) {
    return id;
  }
  const row = await withDb((db) =>
    db.workstream.findUnique({
      where: { organizationId_slug: { organizationId, slug: id } },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

/**
 * Entity-type-aware resolver for entity-link params.
 * Supports slug resolution for ARTIFACT and ISSUE only.
 * EXTERNAL_LINK has no slug field — non-UUID input returns null immediately.
 */
export function resolveEntityLinkIdentifier(
  id: string,
  organizationId: string,
  entityType: EntityType
): Promise<string | null> {
  switch (entityType) {
    case EntityType.Artifact:
      return resolveArtifactId(id, organizationId);
    case EntityType.Issue:
      return resolveIssueId(id, organizationId);
    case EntityType.ExternalLink:
      return Promise.resolve(isUuid(id) ? id : null);
    default:
      return Promise.resolve(isUuid(id) ? id : null);
  }
}
