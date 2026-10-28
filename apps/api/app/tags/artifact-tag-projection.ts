import type {
  ArtifactTagPermissions,
  TagSummary,
} from "@repo/api/src/types/tag";
import { ArtifactTagAvailability } from "@repo/api/src/types/tag";
import {
  mapTagRelations,
  TAG_SUMMARY_SELECT,
} from "@/app/tags/tag-projection-select";
import { hasApiKeyScopes } from "@/lib/auth/api-key-scopes";
import type { AuthContext } from "@/lib/auth/with-auth";

/**
 * ISS-8712: the generic `TagArtifact` read + projection, shared by every
 * artifact-backed surface that shows the org tag vocabulary.
 *
 * Hoisted out of `apps/api/app/branches/branch-tag-projection.ts`, which shipped
 * this logic first for Branches (ISS-4760) and now delegates here. The join, the
 * cross-organization scoping, and the identity de-duplication below are
 * properties of the relation itself, not of Branches — so when Sessions began
 * projecting the same relation the choice was one implementation both read or a
 * copy that agrees only until someone fixes a bug in one of them.
 */
export const artifactTagsSelect = {
  orderBy: { tagId: "asc" },
  select: {
    tag: {
      select: {
        ...TAG_SUMMARY_SELECT,
        organizationId: true,
      },
    },
  },
} as const;

/** Scope the join itself; the mapper repeats the check as defense in depth. */
export function artifactTagsSelectForOrganization(organizationId: string) {
  return {
    ...artifactTagsSelect,
    where: { tag: { organizationId } },
  } as const;
}

export type ArtifactTagRelation = {
  tag: {
    id: string;
    name: string;
    color: string;
    organizationId: string;
  };
};

export type ArtifactTagProjection = {
  tagAvailability: ArtifactTagAvailability;
  tags?: TagSummary[];
  tagPermissions?: ArtifactTagPermissions;
};

/**
 * Project generic tag relations without leaking cross-organization rows or
 * collapsing distinct tag identities that happen to share a display name.
 *
 * `undefined` relations mean the producer never loaded the join, which is
 * reported as `Unavailable` WITHOUT a `tags` key — a caller must not read that
 * as "no tags". An empty array is the opposite claim and is reported as
 * `Available` with `tags: []`.
 */
export function projectArtifactTags(
  relations: readonly ArtifactTagRelation[] | undefined,
  organizationId: string,
  permissions?: ArtifactTagPermissions
): ArtifactTagProjection {
  if (relations === undefined) {
    return {
      tagAvailability: ArtifactTagAvailability.Unavailable,
      ...(permissions ? { tagPermissions: permissions } : {}),
    };
  }

  const seenTagIds = new Set<string>();
  const scopedRelations: ArtifactTagRelation[] = [];
  for (const relation of relations) {
    if (
      relation.tag.organizationId !== organizationId ||
      seenTagIds.has(relation.tag.id)
    ) {
      continue;
    }
    seenTagIds.add(relation.tag.id);
    scopedRelations.push(relation);
  }

  return {
    tagAvailability: ArtifactTagAvailability.Available,
    tags: mapTagRelations(
      scopedRelations.map(({ tag }) => ({
        tag: { id: tag.id, name: tag.name, color: tag.color },
      }))
    ),
    ...(permissions ? { tagPermissions: permissions } : {}),
  };
}

/**
 * Mirror the generic tag route scopes without changing auth policy.
 *
 * This reports what the caller MAY ask for so a client can render the right
 * affordances. It is not the boundary: `/entity-tags` re-checks scope and org
 * ownership on every write, so a client that ignores this gains nothing.
 */
export function artifactTagPermissionsForAuth(
  context: AuthContext
): ArtifactTagPermissions {
  return {
    canApply: hasApiKeyScopes(context, ["write"]),
    canRemove: hasApiKeyScopes(context, ["delete"]),
  };
}
