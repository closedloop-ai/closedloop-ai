import type { Octokit } from "@octokit/rest";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import {
  GitHubActorType,
  normalizeGitHubActorType,
} from "@repo/api/src/types/github-actor";
import { z } from "zod";

const CHECK_SUITES_PER_PAGE = 100;
const MAX_CHECK_SUITE_PAGES = 10;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

const actorSchema = z.looseObject({
  __typename: z.string(),
  login: z.string().optional(),
  databaseId: z
    .number()
    .int()
    .positive()
    .refine(Number.isSafeInteger)
    .nullish(),
});
const pushSchema = z.object({
  id: z.string().min(1),
  previousSha: z.string().nullish(),
  nextSha: z.string().nullish(),
  pusher: actorSchema,
});
const suiteSchema = z.object({
  branch: z.object({ name: z.string() }).nullable(),
  push: pushSchema.nullable(),
});
const connectionSchema = z.object({
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
  nodes: z.array(suiteSchema.nullable()).nullable(),
});
const responseSchema = z.object({
  repository: z
    .object({
      object: z
        .object({
          checkSuites: connectionSchema.nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

const CHECK_SUITE_PUSH_QUERY = `
  query BranchPushesForCommit($owner: String!, $repo: String!, $sha: String!, $after: String, $first: Int!) {
    repository(owner: $owner, name: $repo) {
      object(expression: $sha) {
        ... on Commit {
          checkSuites(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              branch { name }
              push {
                id previousSha nextSha
                pusher {
                  __typename login
                  ... on User { databaseId }
                  ... on Mannequin { databaseId }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export type HistoricalBranchPush = {
  pushId: string;
  beforeSha: string;
  afterSha: string;
  providerUserId: string;
  providerLogin?: string;
  actorType: typeof GitHubActorType.User | typeof GitHubActorType.Mannequin;
};

export type CheckSuitePushEvidence = {
  pushes: HistoricalBranchPush[];
  availability: BranchIdentityAvailability;
  /** Exact-ref provider observations that must not be replaced with webhook sender attribution. */
  excludedTransitions?: { beforeSha: string; afterSha: string }[];
};

/** Read bounded historical Push identities for one commit and exact Branch ref. */
export async function getCheckSuitePushEvidenceForCommit(
  octokit: Pick<Octokit, "graphql">,
  input: { owner: string; repo: string; commitSha: string; branchName: string }
): Promise<CheckSuitePushEvidence> {
  const pushes = new Map<string, HistoricalBranchPush>();
  const excludedTransitions = new Map<
    string,
    { beforeSha: string; afterSha: string }
  >();
  let after: string | null = null;
  for (let page = 0; page < MAX_CHECK_SUITE_PAGES; page++) {
    const connection = await readCheckSuitePage(octokit, input, after);
    if (!connection?.nodes) {
      return {
        pushes: [...pushes.values()],
        availability:
          pushes.size > 0
            ? BranchIdentityAvailability.Incomplete
            : BranchIdentityAvailability.Unavailable,
        ...excludedTransitionEvidence(excludedTransitions),
      };
    }
    for (const suite of connection.nodes) {
      if (suite?.branch?.name !== input.branchName || !suite.push) {
        continue;
      }
      collectPushObservation(suite.push, pushes, excludedTransitions);
    }
    if (!connection.pageInfo.hasNextPage) {
      // Check suites are not a complete event enumeration, even when this
      // connection ends. Known people survive while historical gaps stay open.
      return {
        pushes: [...pushes.values()],
        availability: BranchIdentityAvailability.Incomplete,
        ...excludedTransitionEvidence(excludedTransitions),
      };
    }
    if (!connection.pageInfo.endCursor) {
      break;
    }
    after = connection.pageInfo.endCursor;
  }
  return {
    pushes: [...pushes.values()],
    availability: BranchIdentityAvailability.Incomplete,
    ...excludedTransitionEvidence(excludedTransitions),
  };
}

async function readCheckSuitePage(
  octokit: Pick<Octokit, "graphql">,
  input: { owner: string; repo: string; commitSha: string },
  after: string | null
): Promise<z.infer<typeof connectionSchema> | null> {
  try {
    const raw: unknown = await octokit.graphql(CHECK_SUITE_PUSH_QUERY, {
      owner: input.owner,
      repo: input.repo,
      sha: input.commitSha,
      after,
      first: CHECK_SUITES_PER_PAGE,
    });
    const parsed = responseSchema.safeParse(raw);
    return parsed.success
      ? (parsed.data.repository?.object?.checkSuites ?? null)
      : null;
  } catch {
    return null;
  }
}

function projectHistoricalPush(
  push: z.infer<typeof pushSchema>
): HistoricalBranchPush | null {
  const actorType = normalizeGitHubActorType(push.pusher.__typename);
  if (
    (actorType !== GitHubActorType.User &&
      actorType !== GitHubActorType.Mannequin) ||
    push.pusher.login?.toLowerCase() === "ghost" ||
    !push.pusher.databaseId ||
    !push.previousSha ||
    !push.nextSha ||
    !SHA_RE.test(push.previousSha) ||
    !SHA_RE.test(push.nextSha) ||
    push.previousSha.toLowerCase() === push.nextSha.toLowerCase()
  ) {
    return null;
  }
  return {
    pushId: push.id,
    beforeSha: push.previousSha.toLowerCase(),
    afterSha: push.nextSha.toLowerCase(),
    providerUserId: String(push.pusher.databaseId),
    ...(push.pusher.login ? { providerLogin: push.pusher.login } : {}),
    actorType,
  };
}

function projectExcludedTransition(
  push: z.infer<typeof pushSchema>
): { beforeSha: string; afterSha: string } | null {
  if (
    !(
      push.previousSha &&
      push.nextSha &&
      SHA_RE.test(push.previousSha) &&
      SHA_RE.test(push.nextSha)
    ) ||
    push.previousSha.toLowerCase() === push.nextSha.toLowerCase()
  ) {
    return null;
  }
  return {
    beforeSha: push.previousSha.toLowerCase(),
    afterSha: push.nextSha.toLowerCase(),
  };
}

function excludedTransitionEvidence(
  ranges: ReadonlyMap<string, { beforeSha: string; afterSha: string }>
): Pick<CheckSuitePushEvidence, "excludedTransitions"> {
  return ranges.size > 0 ? { excludedTransitions: [...ranges.values()] } : {};
}

function collectPushObservation(
  push: z.infer<typeof pushSchema>,
  people: Map<string, HistoricalBranchPush>,
  excluded: Map<string, { beforeSha: string; afterSha: string }>
): void {
  const candidate = projectHistoricalPush(push);
  if (candidate) {
    people.set(candidate.pushId, candidate);
    return;
  }
  const transition = projectExcludedTransition(push);
  if (transition) {
    excluded.set(push.id, transition);
  }
}
