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
  /**
   * ISS-8155: optional, because a client can now legitimately have no measured
   * base ref for the PR it is linking. The service never reads it — the branch's
   * base comes from the live pull request it re-fetches — and it is not one of
   * `findAssertionMismatch`'s checks, so requiring a non-empty value only turned
   * an honest absence into a 400. Still `.min(1)` when present: `""` is the
   * absence, and the absence is spelled by omitting the field.
   */
  baseBranch: z.string().min(1).optional(),
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
   * ISS-10169: what this request ACTUALLY linked, one entry per link it was
   * asked to write, read back from the upsert rather than echoed from the
   * input. `[]` is the load-bearing value: the defect this closes is that a
   * caller could not tell "linked" from "did nothing", because the only other
   * read path (`GET /artifact-links?artifactId=<uuid>`) is a second request the
   * write response never mentioned.
   *
   * OPTIONAL ONLY FOR VERSION SKEW, and the two absences are different facts.
   * This server ALWAYS sends the field, so `[]` still means "linked nothing".
   * The field is missing only when a newer bundle reached a pre-ISS-10169 API,
   * which returned `{ id }` alone — a response shape a required field would
   * make look impossible to every consumer. Read an absent field as "this
   * server cannot tell me", never as "nothing was linked".
   */
  linkedArtifacts?: PullRequestArtifactLinkResult[];
  /**
   * ISS-10169: whether `id` names an artifact THIS request created. A branch
   * artifact is upserted on `(organizationId, repositoryFullName, branchName)`,
   * so linking a PR on a reused branch legitimately returns a row that predates
   * the pull request. That is not an error, but a caller handed back an id with
   * no way to tell the two apart cannot verify anything — it has to guess, or
   * compare UUIDv7 timestamps.
   *
   * Optional for the same version-skew reason as `linkedArtifacts`: absent is a
   * pre-ISS-10169 server, not `false`.
   */
  branchArtifactCreated?: boolean;
  /**
   * ISS-10169: the pull request the returned branch artifact now carries, so a
   * caller can confirm the row it got back is the PR it asked to link rather
   * than an unrelated one on the same branch.
   *
   * Optional AND nullable, because the two spellings answer different
   * questions: `null` is this server saying the branch carries no current PR
   * detail, absent is a pre-ISS-10169 server that never reported one. `null` is
   * therefore serialized deliberately rather than omitted — the receiving
   * contract declares it nullable, which is the exception the omit-don't-null
   * rule names.
   */
  currentPullRequest?: LinkedPullRequestIdentity | null;
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

/**
 * ISS-10169: one requested link, READ BACK from the write that made it.
 *
 * Deliberately records only that the edge exists and which row it is. Whether
 * THIS request created it or found it already there would need a read before
 * the write to establish, and the write is a single atomic upsert on purpose
 * (`AGENTS.md`: never decompose an atomic operation into separate reads and
 * writes). An invented distinction bought by giving that up would be worth
 * less than the atomicity it cost.
 */
export type PullRequestArtifactLinkResult = {
  /** The artifact that owns the PRODUCES relationship (the link's source). */
  sourceArtifactId: string;
  /** The `artifact_links` row id, so the caller can address the edge it got. */
  linkId: string;
};

/**
 * ISS-10169: enough of a pull request to CONFIRM it without a second request —
 * the number and url the ticket names as the identifying pair.
 */
export type LinkedPullRequestIdentity = {
  number: number;
  htmlUrl: string | null;
};
