import type { Octokit } from "@octokit/rest";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { z } from "zod";

const EVENTS_PER_PAGE = 100;
const MAX_EVENT_PAGES = 10;
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
const forcePushSchema = z.looseObject({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  ref: z.looseObject({ prefix: z.string(), name: z.string() }).nullable(),
  actor: actorSchema.nullable(),
  beforeCommit: z.looseObject({ oid: z.string() }).nullable(),
  afterCommit: z.looseObject({ oid: z.string() }).nullable(),
});
const timelineConnectionSchema = z.object({
  nodes: z.array(forcePushSchema.nullable()).nullable(),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
});
const responseSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          timelineItems: timelineConnectionSchema,
        })
        .nullable(),
    })
    .nullable(),
});

const FORCE_PUSH_QUERY = `
  query BranchForcePushesForPullRequest($owner: String!, $repo: String!, $number: Int!, $after: String, $first: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        timelineItems(first: $first, after: $after, itemTypes: HEAD_REF_FORCE_PUSHED_EVENT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ... on HeadRefForcePushedEvent {
              id createdAt
              ref { prefix name }
              beforeCommit { oid }
              afterCommit { oid }
              actor {
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
`;

/** A PR force-push observation awaiting new-commit verification. */
export type PullRequestForcePushEvent = {
  eventId: string;
  beforeSha: string;
  afterSha: string;
  providerUserId: string;
  providerLogin?: string;
  actorType: typeof GitHubActorType.User | typeof GitHubActorType.Mannequin;
  observedAt: Date;
};

export type PullRequestForcePushEvidence = {
  events: PullRequestForcePushEvent[];
  availability: BranchIdentityAvailability;
};

/** Read exact-ref PR force-push actors through a bounded timeline connection. */
export async function getPullRequestForcePushEvents(
  octokit: Pick<Octokit, "graphql">,
  input: { owner: string; repo: string; pullNumber: number; branchName: string }
): Promise<PullRequestForcePushEvidence> {
  const events = new Map<string, PullRequestForcePushEvent>();
  let after: string | null = null;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const connection = await readPage(octokit, input, after);
    if (!connection?.nodes) {
      return evidenceAfterRead(events, page === 0);
    }
    for (const node of connection.nodes) {
      const event = projectEvent(node, input.branchName);
      if (event) {
        events.set(event.eventId, event);
      }
    }
    if (!connection.pageInfo.hasNextPage) {
      return evidenceAfterRead(events, false);
    }
    if (!connection.pageInfo.endCursor) {
      break;
    }
    after = connection.pageInfo.endCursor;
  }
  return evidenceAfterRead(events, false);
}

async function readPage(
  octokit: Pick<Octokit, "graphql">,
  input: { owner: string; repo: string; pullNumber: number },
  after: string | null
): Promise<z.infer<typeof timelineConnectionSchema> | null> {
  try {
    const raw: unknown = await octokit.graphql(FORCE_PUSH_QUERY, {
      owner: input.owner,
      repo: input.repo,
      number: input.pullNumber,
      after,
      first: EVENTS_PER_PAGE,
    });
    const parsed = responseSchema.safeParse(raw);
    return parsed.success
      ? (parsed.data.repository?.pullRequest?.timelineItems ?? null)
      : null;
  } catch {
    return null;
  }
}

function projectEvent(
  node: z.infer<typeof forcePushSchema> | null,
  branchName: string
): PullRequestForcePushEvent | null {
  if (
    node?.ref?.prefix !== "refs/heads/" ||
    node.ref.name !== branchName ||
    !node.actor?.databaseId ||
    node.actor.login?.toLowerCase() === "ghost" ||
    (node.actor.__typename !== GitHubActorType.User &&
      node.actor.__typename !== GitHubActorType.Mannequin) ||
    !node.beforeCommit ||
    !node.afterCommit ||
    !SHA_RE.test(node.beforeCommit.oid) ||
    !SHA_RE.test(node.afterCommit.oid) ||
    node.beforeCommit.oid.toLowerCase() === node.afterCommit.oid.toLowerCase()
  ) {
    return null;
  }
  return {
    eventId: node.id,
    beforeSha: node.beforeCommit.oid.toLowerCase(),
    afterSha: node.afterCommit.oid.toLowerCase(),
    providerUserId: String(node.actor.databaseId),
    ...(node.actor.login ? { providerLogin: node.actor.login } : {}),
    actorType: node.actor.__typename,
    observedAt: new Date(node.createdAt),
  };
}

function evidenceAfterRead(
  events: ReadonlyMap<string, PullRequestForcePushEvent>,
  firstPageFailed: boolean
): PullRequestForcePushEvidence {
  return {
    events: [...events.values()],
    availability: firstPageFailed
      ? BranchIdentityAvailability.Unavailable
      : BranchIdentityAvailability.Incomplete,
  };
}
