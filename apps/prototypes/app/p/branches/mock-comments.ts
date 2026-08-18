import {
  type PrComment,
  PrCommentProviderKind,
  type PrCommentsAvailability,
  PrCommentsState,
  type SessionLane,
} from "./mock";

export const SEED_PROVIDER_COMMENTS: PrComment[] = [
  {
    id: "c1",
    author: "Sam Chen",
    at: "1h ago",
    path: "packages/database/seed/synthetic-generator.ts",
    line: 88,
    anchorPreview: "for (const org of orgs) await generateFor(org);",
    body: "Can we clamp the batch size here? An unbounded loop over the org set will blow the worker heap.",
    provider: {
      bodyTruncated: true,
      kind: PrCommentProviderKind.Review,
      line: 88,
      login: "sam-chen",
      path: "packages/database/seed/synthetic-generator.ts",
      providerUrl:
        "https://github.com/closedloop-ai/symphony-alpha/pull/1284#discussion_r101",
      resolved: false,
      stale: true,
    },
    replies: [
      {
        id: "c2",
        author: "alex-rivera",
        at: "52m ago",
        body: "Good catch — pushed a floor + ceiling and a test. See the latest commit.",
        provider: {
          bodyTruncated: true,
          kind: PrCommentProviderKind.ReviewReply,
          line: 89,
          login: "alex-rivera",
          path: "packages/database/seed/synthetic-generator.ts",
          providerUrl:
            "https://github.com/closedloop-ai/symphony-alpha/pull/1284#discussion_r102",
          resolved: true,
          stale: true,
        },
      },
    ],
  },
  {
    id: "c3",
    author: "parker-byrd",
    at: "40m ago",
    path: "apps/api/lib/fixtures/seed-config.ts",
    line: 21,
    anchorPreview: 'const mode = "apply";',
    body: "Prefer the const-object enum over the string literal for the mode field.",
    provider: {
      bodyTruncated: false,
      kind: PrCommentProviderKind.Issue,
      login: "parker-byrd",
      providerUrl:
        "https://github.com/closedloop-ai/symphony-alpha/pull/1284#issuecomment-103",
      stale: false,
    },
  },
];

export const SEED_PROVIDER_AVAILABILITY: PrCommentsAvailability = {
  bodyTruncatedCount: 2,
  mixedProjection: true,
  omittedComments: 3,
  providerTruncated: true,
  responseTruncated: false,
  stale: true,
  state: PrCommentsState.StaleMixed,
};

const PR_COMMENTS_BY_BRANCH: Record<string, PrComment[]> = {
  br_1270: [
    {
      id: "repo-overrides-1",
      author: "alex-rivera",
      at: "2h ago",
      path: "apps/api/lib/repositories/resolve-overrides.ts",
      line: 74,
      anchorPreview: "const overrides = workspace.repositoryOverrides;",
      body: "What happens for workspaces that have not run the backfill yet? We should preserve the repository-level fallback until migration is complete.",
    },
    {
      id: "repo-overrides-2",
      author: "parker-byrd",
      at: "1h ago",
      body: "Added the fallback and a mixed-state fixture. Existing workspaces now resolve the old value until the backfill marks them migrated.",
    },
  ],
  br_1289: [
    {
      id: "skill-registry-1",
      author: "sam-chen",
      at: "1d ago",
      path: "packages/agents/src/skills/registry-loader.ts",
      line: 116,
      anchorPreview: "return registryCache.get(workspaceId);",
      body: "This cache never invalidates when a workspace installs a new skill. Can we key it by the registry revision or subscribe to the install event?",
    },
    {
      id: "skill-registry-2",
      author: "jordan-lee",
      at: "22h ago",
      body: "Requesting changes until invalidation is covered. A stale registry here would make newly installed skills appear unavailable to running agents.",
    },
  ],
};

const EMPTY_SESSION_COMMENTS = new Set([
  "br_dark_mode",
  "br_session_cost",
  "br_dependabot",
]);

const SESSION_COMMENT_COPY: Record<string, { first: string; second?: string }> =
  {
    br_1284: {
      first:
        "The trace makes the batch-size decision easy to follow. Can we pin the tool result that showed the worker heap limit?",
      second:
        "This session resumed after the failed test run. The 11-minute gap is CI queue time, not active agent work.",
    },
    br_1281: {
      first:
        "The switch from polling to presence happens here. It would help to call out why the subscription belongs at the route boundary.",
      second:
        "This follow-up session reproduced the unmount leak before adding cleanup. Keep that failed reproduction visible in the trace.",
    },
    br_1270: {
      first:
        "This is where the agent discovered mixed migration state. Please annotate the decision to retain the repository-level fallback.",
      second:
        "The second session starts from review feedback rather than the original plan, so this should count as rework.",
    },
    br_saml: {
      first:
        "The assertion-validation reasoning is useful. Can we highlight the point where the implementation changed to a timing-safe comparison?",
      second:
        "This resumed after security review. The trace should distinguish the tampered-assertion test from the original happy-path coverage.",
    },
    br_1289: {
      first:
        "The cache invalidation assumption first appears here. Pinning it would explain why review later requested a registry revision key.",
      second:
        "This retry followed a tool timeout. The idle interval should stay classified as waiting rather than agent work.",
    },
  };

export function getPrComments(
  branchId: string,
  fallback: PrComment[],
  hasComments: boolean
): PrComment[] {
  if (!hasComments) {
    return [];
  }
  return PR_COMMENTS_BY_BRANCH[branchId] ?? fallback;
}

export function buildSessionComments(
  branchId: string,
  sessions: SessionLane[]
): PrComment[] {
  if (EMPTY_SESSION_COMMENTS.has(branchId)) {
    return [];
  }

  const firstSession = sessions[0];
  const secondSession = sessions[1];
  const comments: PrComment[] = [];
  const copy = SESSION_COMMENT_COPY[branchId] ?? {
    first:
      "Can we annotate the point in this trace where the implementation direction changed?",
    second:
      "This session resumed after external feedback; the idle gap is waiting time, not active agent work.",
  };

  if (firstSession) {
    comments.push({
      id: `session-${firstSession.id}-1`,
      author: "parker-byrd",
      at: "34m ago",
      anchorPreview: `${firstSession.actor} · ${firstSession.sub}`,
      body: copy.first,
    });
  }

  if (secondSession && copy.second) {
    comments.push({
      id: `session-${secondSession.id}-2`,
      author: "alex-rivera",
      at: "18m ago",
      anchorPreview: `${secondSession.actor} · ${secondSession.sub}`,
      body: copy.second,
    });
  }

  return comments;
}
