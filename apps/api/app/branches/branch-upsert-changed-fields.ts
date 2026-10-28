import { LinkType } from "@repo/api/src/types/artifact";
import type { TransactionClient } from "@repo/database";

/**
 * ISS-12552: the persisted branch fields an upsert onto an existing
 * branch can move, as named on its receipt's `changedFields`. An upsert that
 * moves none of them is a no-op (PRD-800 "An update or saved version that
 * changes no content and no persisted field is a no-op").
 */
export const BranchUpsertField = {
  BaseBranch: "baseBranch",
  BaseBranchSource: "baseBranchSource",
  HeadSha: "headSha",
  HeadShaSource: "headShaSource",
  ProjectId: "projectId",
  SourceLink: "sourceLink",
} as const;
export type BranchUpsertField =
  (typeof BranchUpsertField)[keyof typeof BranchUpsertField];

type BranchFieldValues = {
  projectId: string | null;
  branch: {
    baseBranch: string | null;
    baseBranchSource: string | null;
    headSha: string | null;
    headShaSource: string | null;
  } | null;
};

/**
 * Whether the upsert is about to add a PRODUCES link from `sourceArtifactId`
 * to the branch, read before the upsert writes it so a newly added source link
 * counts as a moved field.
 */
export async function addsBranchSourceLink(
  tx: TransactionClient,
  sourceArtifactId: string | null | undefined,
  branchArtifactId: string
): Promise<boolean> {
  if (!sourceArtifactId) {
    return false;
  }
  const link = await tx.artifactLink.findUnique({
    where: {
      sourceId_targetId_linkType: {
        sourceId: sourceArtifactId,
        targetId: branchArtifactId,
        linkType: LinkType.Produces,
      },
    },
    select: { id: true },
  });
  return link === null;
}

/** The fields that moved between the branch as read before and after. */
export function branchUpsertChangedFields(
  before: BranchFieldValues,
  after: BranchFieldValues,
  sourceLinkAdded: boolean
): BranchUpsertField[] {
  const moved: BranchUpsertField[] = [];
  const pairs: [BranchUpsertField, unknown, unknown][] = [
    [
      BranchUpsertField.BaseBranch,
      before.branch?.baseBranch,
      after.branch?.baseBranch,
    ],
    [
      BranchUpsertField.BaseBranchSource,
      before.branch?.baseBranchSource,
      after.branch?.baseBranchSource,
    ],
    [BranchUpsertField.HeadSha, before.branch?.headSha, after.branch?.headSha],
    [
      BranchUpsertField.HeadShaSource,
      before.branch?.headShaSource,
      after.branch?.headShaSource,
    ],
    [BranchUpsertField.ProjectId, before.projectId, after.projectId],
  ];
  for (const [field, previous, next] of pairs) {
    if ((previous ?? null) !== (next ?? null)) {
      moved.push(field);
    }
  }
  if (sourceLinkAdded) {
    moved.push(BranchUpsertField.SourceLink);
  }
  return moved;
}
