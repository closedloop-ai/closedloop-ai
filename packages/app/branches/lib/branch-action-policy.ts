import {
  BranchTagAvailability,
  type BranchTagPermissions,
} from "@repo/api/src/types/branch";
import { z } from "zod";
import { isGithubPrUrl } from "./branch-pr-url";

/** Branch actions governed by route, identity, host, and permission facts. */
export const BranchRowPolicyAction = {
  OpenDetail: "open_detail",
  CopyBranchName: "copy_branch_name",
  OpenPullRequest: "open_pull_request",
  ViewSessions: "view_sessions",
  BulkTagApply: "bulk_tag_apply",
} as const;
export type BranchRowPolicyAction =
  (typeof BranchRowPolicyAction)[keyof typeof BranchRowPolicyAction];

/** Validated availability for every governed row action. */
export type BranchRowActionApplicability = Record<
  BranchRowPolicyAction,
  boolean
>;

/** Raw production facts used to derive Branch action applicability. */
export type BranchRowActionPolicyInput = {
  hasArtifactIdentity: boolean;
  hasDetailRoute: boolean;
  hasSessionsRoute: boolean;
  hostCanMutate: boolean;
  prNumber: number | null;
  prUrl: string | null;
  sessionCount: number;
  supportsTags: boolean;
  tagAvailability?: BranchTagAvailability;
  tagPermissions?: BranchTagPermissions;
};

const branchRowActionPolicyInputSchema = z
  .object({
    hasArtifactIdentity: z.boolean(),
    hasDetailRoute: z.boolean(),
    hasSessionsRoute: z.boolean(),
    hostCanMutate: z.boolean(),
    prNumber: z.number().int().positive().nullable(),
    prUrl: z.string().nullable(),
    sessionCount: z.number().int().nonnegative(),
    supportsTags: z.boolean(),
    tagAvailability: z.enum(Object.values(BranchTagAvailability)).optional(),
    tagPermissions: z
      .object({ canApply: z.boolean(), canRemove: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();

/** Validates production facts and derives the complete action matrix. */
export function resolveBranchRowActionApplicability(
  input: unknown
): BranchRowActionApplicability {
  const parsed = branchRowActionPolicyInputSchema.safeParse(input);
  if (!parsed.success) {
    return deniedRowActions();
  }

  const facts = parsed.data;
  const tagsAvailable =
    facts.tagAvailability !== BranchTagAvailability.Unavailable &&
    facts.tagPermissions !== undefined;
  const canApplyTag = facts.tagPermissions?.canApply ?? false;
  const hasCurrentPullRequestRoute =
    facts.prNumber !== null && isGithubPrUrl(facts.prUrl);

  return {
    [BranchRowPolicyAction.OpenDetail]: facts.hasDetailRoute,
    [BranchRowPolicyAction.CopyBranchName]: true,
    [BranchRowPolicyAction.OpenPullRequest]: hasCurrentPullRequestRoute,
    [BranchRowPolicyAction.ViewSessions]:
      facts.hasSessionsRoute && facts.sessionCount > 0,
    [BranchRowPolicyAction.BulkTagApply]:
      facts.hostCanMutate &&
      facts.hasArtifactIdentity &&
      facts.supportsTags &&
      tagsAvailable &&
      canApplyTag,
  };
}

function deniedRowActions(): BranchRowActionApplicability {
  return {
    [BranchRowPolicyAction.OpenDetail]: false,
    [BranchRowPolicyAction.CopyBranchName]: false,
    [BranchRowPolicyAction.OpenPullRequest]: false,
    [BranchRowPolicyAction.ViewSessions]: false,
    [BranchRowPolicyAction.BulkTagApply]: false,
  };
}
