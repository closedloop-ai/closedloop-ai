import { z } from "zod";
import { GitHubPRState } from "./github.ts";
import type { PullRequestLabelSyncResult } from "./pull-request-label-sync-status.ts";

/**
 * ISS-4764: the SINGLE owner of the `POST /artifact-links/pull-requests`
 * request/response contract.
 *
 * It previously existed twice — a hand-written type in the shared web/desktop
 * `select-pr-dialog` component and the Zod schema in the API route's
 * `route-contract.ts`. Both were internally valid, so `tsc` could not see them
 * drift; adding `sourceArtifactId` on #4153 had to be done in both by hand.
 * Frontend and backend now import this module and nothing else.
 */
export const createPrArtifactValidator = z.object({
  projectId: z.uuid(),
  title: z.string().min(1),
  externalUrl: z.string().min(1),
  number: z.number().int().positive(),
  githubId: z.string().min(1),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  headSha: z.string().trim().min(1).nullable().optional(),
  state: z.enum(GitHubPRState),
  isDraft: z.boolean().optional(),
  closedAt: z.string().datetime().nullable().optional(),
  mergedAt: z.string().datetime().nullable().optional(),
  mergeCommitSha: z.string().trim().min(1).nullable().optional(),
  /**
   * ISS-4664: the artifact this PR implements (the ISS/FEATURE the caller is
   * linking it from). Its tags are applied to the PR as GitHub labels
   * immediately, in this request, through the same reconciliation the
   * `pull_request` webhook runs — this endpoint links an ALREADY-OPEN PR, so no
   * `opened` event follows and the webhook alone would not cover it. The
   * webhook stays the ongoing backstop for tags changed after the link exists.
   *
   * ISS-4759: validated as a same-project implementing DOCUMENT before ANY
   * GitHub call. An org-scoped uuid alone is not enough — it would let a caller
   * paint another project's taxonomy onto this repository's pull request.
   *
   * Optional and additive — an older client that omits it gets exactly the
   * previous behavior.
   */
  sourceArtifactId: z.uuid().optional(),
  /**
   * ISS-4759: the artifact that OWNS the produces-relationship (the plan when
   * one exists, otherwise the issue). Distinct from `sourceArtifactId`, which
   * is the TAG source: on the common issue-with-plan flow the plan owns the
   * link while the issue owns the tags.
   *
   * When supplied, the PRODUCES link is written INSIDE the branch upsert
   * transaction, so GitHub can never be labelled against a relationship that
   * was never committed. Previously the client wrote this link out-of-band in a
   * second request that could simply fail.
   *
   * Optional and additive — an older client that omits it still writes its own
   * link afterwards and behaves exactly as before.
   */
  linkSourceArtifactId: z.uuid().optional(),
});

export type CreatePrArtifactInput = z.infer<typeof createPrArtifactValidator>;

export type CreatePrArtifactResponse = {
  id: string;
  /**
   * ISS-4764: what actually happened to the labels. Previously the response was
   * `{ id }` alone, so the dialog's toast read identically whether the labels
   * landed or the GitHub call quietly failed.
   *
   * Optional because it is only present when the caller asked for label
   * propagation at all (`sourceArtifactId`). Absent means "not attempted" —
   * NOT "nothing happened" — and an older client that ignores the field is
   * unaffected.
   */
  labelSync?: PullRequestLabelSyncResult;
  /**
   * ISS-4759: echoed ONLY when this request wrote the PRODUCES link inside the
   * branch transaction. Its absence tells a newer client that the server did
   * not honour `linkSourceArtifactId` (an older API, or a rejected owner), so
   * the client must still write the link itself. Omitted rather than `null`, so
   * an older client sees exactly the previous response shape.
   */
  linkedSourceArtifactId?: string;
};
