import type {
  BranchRow,
  BranchTagPermissions,
} from "@repo/api/src/types/branch";
import {
  artifactTagPermissionsForAuth,
  artifactTagsSelect,
  artifactTagsSelectForOrganization,
  projectArtifactTags,
} from "@/app/tags/artifact-tag-projection";
import type { AuthContext } from "@/lib/auth/with-auth";

/**
 * The Branch surface's names for the generic `TagArtifact` projection.
 *
 * ISS-8712 moved the implementation to `@/app/tags/artifact-tag-projection`
 * when Sessions began projecting the same relation; these remain because every
 * Branch read site and the Branch wire contract spell the Branch-flavoured
 * names, and re-pointing them all would be a rename with no behaviour behind
 * it. The projection's own tests live with the implementation; this module's
 * tests continue to exercise the Branch entry points.
 */

/** Existing generic TagArtifact relation selection for cloud Branch reads. */
export const branchTagArtifactsSelect = artifactTagsSelect;

/** Scope the join itself; the mapper repeats the check as defense in depth. */
export const branchTagArtifactsSelectForOrganization =
  artifactTagsSelectForOrganization;

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
  return projectArtifactTags(relations, organizationId, permissions);
}

/** Mirror the existing generic tag route scopes without changing auth policy. */
export function branchTagPermissionsForAuth(
  context: AuthContext
): BranchTagPermissions {
  return artifactTagPermissionsForAuth(context);
}
