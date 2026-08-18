/**
 * The shapes `github-projection.ts` works in internally: the narrowed client it
 * accepts, the soft-delete inputs, and the result it hands back.
 *
 * Split out of the writer so the module that orchestrates the projection writes
 * is not also the module that declares them. Nothing here is part of the
 * module's public surface — the caller-facing types stay exported from
 * `github-projection.ts`, so no import site moves.
 */

import type {
  GitHubCommentThreadKind,
  TransactionClient,
} from "@repo/database";
import type { GitHubFetchProvenance } from "@/lib/github-fetch-provenance";

export type GitHubProjectionDb = Pick<
  TransactionClient,
  | "comment"
  | "commentThread"
  | "gitHubCommentProjection"
  | "gitHubCommentThreadProjection"
>;

export type SoftDeleteGitHubCommentProjectionInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  threadKind: GitHubCommentThreadKind;
  liveGithubCommentIds: ReadonlySet<string | number>;
  deletedAt: Date;
  fetchProvenance?: GitHubFetchProvenance;
};

export type SoftDeleteScopedGitHubCommentProjectionInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  githubCommentId: string | number;
  deletedAt: Date;
  fetchProvenance?: GitHubFetchProvenance;
};

export type SoftDeleteGitHubCommentByRemoteIdInput =
  SoftDeleteScopedGitHubCommentProjectionInput & {
    threadKind: GitHubCommentThreadKind;
  };

export type UpsertGitHubProjectionResult = {
  threadId: string;
  commentIds: string[];
  /**
   * Remote GitHub ids whose generic Comment row was created by this call.
   * Webhook callers use this as the atomic first-delivery signal for one-time
   * side effects; duplicate deliveries that race on `externalId` do not appear.
   */
  createdGithubCommentIds: string[];
};
