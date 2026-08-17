import type {
  BranchRow,
  BranchTagPermissions,
} from "@repo/api/src/types/branch";
import { BranchTagAvailability } from "@repo/api/src/types/branch";
import { mapTagRelations, TAG_SUMMARY_SELECT } from "@/app/tags/service";
import { hasApiKeyScopes } from "@/lib/auth/api-key-scopes";
import type { AuthContext } from "@/lib/auth/with-auth";

/** Existing generic TagArtifact relation selection for cloud Branch reads. */
export const branchTagArtifactsSelect = {
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
export function branchTagArtifactsSelectForOrganization(
  organizationId: string
) {
  return {
    ...branchTagArtifactsSelect,
    where: { tag: { organizationId } },
  } as const;
}

type BranchTagRelation = {
  tag: {
    id: string;
    name: string;
    color: string;
    organizationId: string;
  };
};

type BranchTagProjection = Pick<
  BranchRow,
  "tagAvailability" | "tagPermissions" | "tags"
>;

/**
 * Project generic tag relations without leaking cross-organization rows or
 * collapsing distinct tag identities that happen to share a display name.
 */
export function projectBranchTags(
  relations: readonly BranchTagRelation[] | undefined,
  organizationId: string,
  permissions?: BranchTagPermissions
): BranchTagProjection {
  if (relations === undefined) {
    return {
      tagAvailability: BranchTagAvailability.Unavailable,
      ...(permissions ? { tagPermissions: permissions } : {}),
    };
  }

  const seenTagIds = new Set<string>();
  const scopedRelations: BranchTagRelation[] = [];
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
    tagAvailability: BranchTagAvailability.Available,
    tags: mapTagRelations(
      scopedRelations.map(({ tag }) => ({
        tag: { id: tag.id, name: tag.name, color: tag.color },
      }))
    ),
    ...(permissions ? { tagPermissions: permissions } : {}),
  };
}

/** Mirror the existing generic tag route scopes without changing auth policy. */
export function branchTagPermissionsForAuth(
  context: AuthContext
): BranchTagPermissions {
  return {
    canApply: hasApiKeyScopes(context, ["write"]),
    canRemove: hasApiKeyScopes(context, ["delete"]),
  };
}
