import type { Octokit } from "@octokit/rest";
import {
  GitHubActorType,
  normalizeGitHubActorType,
} from "@repo/api/src/types/github-actor";
import { z } from "zod";

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const ZERO_SHA_RE = /^0+$/;
const comparisonSchema = z.object({
  ahead_by: z.number().int().nonnegative().refine(Number.isSafeInteger),
});
const repositorySchema = z.object({
  default_branch: z.string().min(1),
});
const accountSchema = z.object({
  id: z.number().int().positive().refine(Number.isSafeInteger),
  login: z.string().min(1),
  type: z.string(),
});
const GHOST_LOGIN = "ghost";

export const BranchPushTransitionState = {
  NewCommits: "new_commits",
  NoNewCommits: "no_new_commits",
  Unavailable: "unavailable",
} as const;
export type BranchPushTransitionState =
  (typeof BranchPushTransitionState)[keyof typeof BranchPushTransitionState];

export type ReportedPushAccount = {
  providerUserId: string;
  providerLogin: string;
  actorType: GitHubActorType;
};

/** Verify that an exact SHA transition added at least one Branch commit. */
export async function verifyBranchPushTransition(
  octokit: Pick<Octokit, "rest">,
  input: { owner: string; repo: string; beforeSha: string; afterSha: string }
): Promise<BranchPushTransitionState> {
  if (
    !(SHA_RE.test(input.beforeSha) && SHA_RE.test(input.afterSha)) ||
    ZERO_SHA_RE.test(input.afterSha)
  ) {
    return BranchPushTransitionState.Unavailable;
  }
  if (input.beforeSha.toLowerCase() === input.afterSha.toLowerCase()) {
    return BranchPushTransitionState.NoNewCommits;
  }
  if (ZERO_SHA_RE.test(input.beforeSha)) {
    const defaultBranch = await readDefaultBranchName(octokit, input);
    if (!defaultBranch) {
      return BranchPushTransitionState.Unavailable;
    }
    return await readComparisonState(
      octokit,
      input,
      `${defaultBranch}...${input.afterSha}`
    );
  }
  return await readComparisonState(
    octokit,
    input,
    `${input.beforeSha}...${input.afterSha}`
  );
}

/** Resolve REST Events' type-free actor by the provider's immutable account ID. */
export async function readReportedPushAccount(
  octokit: Pick<Octokit, "request">,
  providerUserId: string
): Promise<ReportedPushAccount | null> {
  const accountId = Number(providerUserId);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return null;
  }
  try {
    const response = await octokit.request("GET /user/{account_id}", {
      account_id: accountId,
    });
    const parsed = accountSchema.safeParse(response.data);
    if (
      !parsed.success ||
      parsed.data.id !== accountId ||
      parsed.data.login.toLowerCase() === GHOST_LOGIN
    ) {
      return null;
    }
    return {
      providerUserId,
      providerLogin: parsed.data.login,
      actorType:
        normalizeGitHubActorType(parsed.data.type) ?? GitHubActorType.Unknown,
    };
  } catch {
    return null;
  }
}

async function readDefaultBranchName(
  octokit: Pick<Octokit, "rest">,
  input: { owner: string; repo: string }
): Promise<string | null> {
  try {
    const response = await octokit.rest.repos.get({
      owner: input.owner,
      repo: input.repo,
    });
    const parsed = repositorySchema.safeParse(response.data);
    return parsed.success ? parsed.data.default_branch : null;
  } catch {
    return null;
  }
}

async function readComparisonState(
  octokit: Pick<Octokit, "rest">,
  input: { owner: string; repo: string },
  basehead: string
): Promise<BranchPushTransitionState> {
  try {
    const response = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: input.owner,
      repo: input.repo,
      basehead,
      per_page: 1,
    });
    const parsed = comparisonSchema.safeParse(response.data);
    if (!parsed.success) {
      return BranchPushTransitionState.Unavailable;
    }
    return parsed.data.ahead_by > 0
      ? BranchPushTransitionState.NewCommits
      : BranchPushTransitionState.NoNewCommits;
  } catch {
    return BranchPushTransitionState.Unavailable;
  }
}
