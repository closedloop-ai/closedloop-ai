import type { PrComment, SessionLane, TraceTurn } from "./mock";
import { turnExcerpt } from "./trace-text";

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
  sessions: SessionLane[],
  trace: TraceTurn[]
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

  // Anchor the seeded comments to real trace turns so the jump-back and message
  // excerpt render in the default state, not only on notes the viewer creates.
  const firstAnchor = trace.find((turn) => turn.side === "agent") ?? trace[0];
  const secondAnchor =
    trace.find(
      (turn) => turn.side === "agent" && turn.id !== firstAnchor?.id
    ) ?? trace.find((turn) => turn.id !== firstAnchor?.id);

  if (firstSession && firstAnchor) {
    comments.push({
      id: `session-${firstSession.id}-1`,
      author: "parker-byrd",
      at: "34m ago",
      anchorPreview: turnExcerpt(firstAnchor),
      anchorTurnId: firstAnchor.id,
      body: copy.first,
    });
  }

  if (secondSession && copy.second && secondAnchor) {
    comments.push({
      id: `session-${secondSession.id}-2`,
      author: "alex-rivera",
      at: "18m ago",
      anchorPreview: turnExcerpt(secondAnchor),
      anchorTurnId: secondAnchor.id,
      body: copy.second,
    });
  }

  return comments;
}
