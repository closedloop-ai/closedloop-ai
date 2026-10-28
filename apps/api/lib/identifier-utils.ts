import "server-only";

import { TYPED_SLUG_PATTERN } from "@repo/api/src/types/slug";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import { ArtifactType, withDb } from "@repo/database";
import { z } from "zod";
import { isUuid } from "./is-uuid";

/** Legacy nanoid slugs: exactly 14 alphanumeric characters */
const NANOID_SLUG_REGEX = /^[A-Za-z0-9_-]{14}$/;

/**
 * Zod schema that accepts either a UUID or a typed/nanoid slug.
 * Use in place of `z.uuid()` for fields that reference slug-capable entities.
 *
 * Accepted formats:
 * - UUID: `550e8400-e29b-41d4-a716-446655440000`
 * - Typed slug: `PRD-42`, `ISS-1`, `FEA-1`, `PRO-123`, `PLN-7`, `DOC-39`
 * - Legacy nanoid slug: 14-character alphanumeric string
 */
export function uuidOrSlug() {
  return z
    .string()
    .min(1, "ID or slug is required")
    .refine(
      (val) =>
        isUuid(val) ||
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

/**
 * Resolve a document identifier — UUID or slug — to an id inside `organizationId`.
 *
 * ISS-6988: the UUID branch used to hand the input straight back, unverified.
 * That was safe only because every caller happened to re-scope downstream, which
 * put the tenancy boundary in the callers rather than in the resolver: nothing
 * stopped the next consumer from trusting the returned id, and nothing would
 * have failed if one did. Both branches now go through
 * {@link findOrgScopedArtifactId}, so the contract this function's callers may
 * rely on is "a non-null result names a row in `organizationId`" — enforced
 * here, not assumed of them.
 */
export async function resolveDocumentId(
  id: string,
  organizationId: string
): Promise<string | null> {
  if (isUuid(id)) {
    return findOrgScopedArtifactId(id, organizationId);
  }
  // FEA-4137: an incoming `ISS-###` may address an existing row stored as
  // `FEA-###` (and vice-versa), so resolve against every alias slug for the same
  // numeric identity. Only one row can exist per numeric identity, so findFirst
  // over the alias set is unambiguous. Non-Issue/legacy slugs expand to `[id]`.
  const row = await withDb((db) =>
    db.artifact.findFirst({
      where: {
        organizationId,
        slug: { in: expandSlugAliases(id) },
        type: ArtifactType.DOCUMENT,
      },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

/**
 * Resolve a project identifier — UUID or slug — to an id inside `organizationId`.
 *
 * ISS-7447: the UUID branch used to hand the input straight back, unverified —
 * the same shape ISS-6988 removed from {@link resolveDocumentId}. Every caller
 * re-scoped its own follow-up read, so nothing was reachable, but that put the
 * tenancy boundary in the callers instead of in the resolver: the first consumer
 * to trust the returned id would have crossed orgs silently, and neither the
 * signature nor the tests would have moved. Both branches now go through
 * {@link findOrgScopedProjectId}, so the contract callers may rely on is "a
 * non-null result names a project in `organizationId`" — enforced here, not
 * assumed of them.
 */
export async function resolveProjectId(
  id: string,
  organizationId: string
): Promise<string | null> {
  if (isUuid(id)) {
    return await findOrgScopedProjectId(id, organizationId);
  }
  const row = await withDb((db) =>
    db.project.findUnique({
      where: { organizationId_slug: { organizationId, slug: id } },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

/**
 * Resolve an artifact identifier that may be a UUID or a document slug.
 * Non-document artifacts (PR, deployment) don't carry slugs, so non-UUID
 * input falls back to a document lookup first.
 *
 * Both branches are org-scoped, and have been since before ISS-6988 on this
 * side — its UUID branch is the shape `resolveDocumentId` was missing.
 */
export function resolveArtifactIdentifier(
  id: string,
  organizationId: string
): Promise<string | null> {
  if (isUuid(id)) {
    return findOrgScopedArtifactId(id, organizationId);
  }
  return resolveDocumentId(id, organizationId);
}

/**
 * The single org-scoped existence check both UUID branches above resolve through.
 *
 * Deliberately does NOT constrain `type`. `resolveDocumentId` is reached with the
 * UUID of a non-DOCUMENT artifact on live paths — `/documents/[id]/threads`
 * resolves the id here and lets `documentService` decide it is not a document —
 * so narrowing to `ArtifactType.DOCUMENT` here would turn an existing
 * 404-after-lookup into a 404-before-lookup for a row the caller can legitimately
 * address. The tenancy predicate is the whole job; the type question belongs to
 * the caller that knows which artifact kind it wants.
 */
async function findOrgScopedArtifactId(
  id: string,
  organizationId: string
): Promise<string | null> {
  const row = await withDb((db) =>
    db.artifact.findFirst({
      where: { id, organizationId },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

/**
 * The single org-scoped existence check {@link resolveProjectId}'s UUID branch
 * resolves through (ISS-7447).
 *
 * `findFirst` rather than the `organizationId_slug` `findUnique` the slug branch
 * uses: tenancy is not part of the primary key, so an id lookup has to carry the
 * org as an ordinary predicate. A `findUnique` on `id` alone would fetch the row
 * and leave the org comparison to the caller, which is the defect this replaced.
 */
async function findOrgScopedProjectId(
  id: string,
  organizationId: string
): Promise<string | null> {
  const row = await withDb((db) =>
    db.project.findFirst({
      where: { id, organizationId },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}
