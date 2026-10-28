// gardener-support: test and story data, not shipped
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { resolveSessionDetailDisplayStatus } from "@repo/app/agents/lib/session-detail-display-status";
// Feature slice -> shared: the design harness feeds the shared preview's
// comments rail and Details sections, which read these generic shapes.
import type { GenericCommentRecord } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-rail";
import type { SessionDetailsTabInput } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-fixtures";
import { detailsAssociatedRecord } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-fixtures";
import {
  DetailsLinkEnd,
  DetailsLinkType,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import {
  formatCostPrecise,
  formatLocPerDollar,
} from "@repo/app/shared/lib/format-utils";
import { populatedAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { deriveCacheWriteTtlBreakdown } from "../session-cache-write-ttl";

/** ISS-10964 design harness: the populated Session Detail fixture. */
export const SESSION_DESIGN_SESSION = populatedAgentSessionDetailFixture;

/** The fixture's first prompt row, which the trace comments anchor to. */
const COMMENT_ROW = 0;
const COMMENT_ANCHOR_TEXT = "Please inspect the shared session detail screen.";

/**
 * The Session as the shared Details tab and comments rail read it, derived
 * from the same fixture. Fictional people only; the Details layout is
 * ISS-10792's.
 */
export const SESSION_DESIGN_ARTIFACT: GenericArtifact = {
  id: `session-design-${SESSION_DESIGN_SESSION.id}`,
  slug: SESSION_DESIGN_SESSION.slug ?? SESSION_DESIGN_SESSION.id,
  title: SESSION_DESIGN_SESSION.name ?? SESSION_DESIGN_SESSION.id,
  summary: "Fixture: a desktop implementation session.",
  kind: ArtifactKind.Session,
  // The preview overrides `statusRaw` with the displayed status, so Details
  // and the header badge read one value.
  status: ArtifactStatus.Completed,
  owner: "Ada Lovelace",
  ownerInitials: "AL",
  collaborators: ["Morgan Fixture", "Pascoe Fixture", "Sam Fixture"],
  repository: SESSION_DESIGN_SESSION.repositoryFullName ?? null,
  project: null,
  tags: [],
  commentCount: 2,
  currentVersion: "1",
  updated: "Jun 10",
  updatedAgoMinutes: 0,
  createdAgoDays: 0,
  aiSpend: SESSION_DESIGN_SESSION.estimatedCost ?? 0,
  timeToReadyMinutes: 0,
  outcomeScore: 0,
  activityCount: SESSION_DESIGN_SESSION.turnItems?.length ?? 0,
  relationshipCount: 0,
};

function traceComment(
  id: string,
  body: string,
  status: "open" | "resolved"
): GenericCommentRecord {
  return {
    id,
    author: "Morgan Fixture",
    body,
    anchorPreview: COMMENT_ANCHOR_TEXT,
    context: "Session trace",
    time: "Jun 10",
    traceRow: COMMENT_ROW,
    anchor: {
      kind: CommentAnchorKind.Trace,
      row: COMMENT_ROW,
      selectedText: COMMENT_ANCHOR_TEXT,
    },
    source: { provider: "native" },
    status,
  };
}

/** Trace comments: selecting one moves the trace to its row. */
export const SESSION_DESIGN_COMMENTS: readonly GenericCommentRecord[] = [
  traceComment(
    "session-design-trace-comment",
    "Fixture: can we confirm the vitest failure is unrelated?",
    "open"
  ),
  traceComment(
    "session-design-trace-comment-resolved",
    "Fixture: the prompt reads clearly now.",
    "resolved"
  ),
];

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : "";

/**
 * ISS-12252: the values the Details tab reads, from the same fixture, so
 * the tab describes the session the page header names. As the Properties
 * panel does, the Session ID is the harness's id and the harness its raw name.
 */
const LINES_CHANGED = {
  additions: SESSION_DESIGN_SESSION.linesAdded ?? 0,
  deletions: SESSION_DESIGN_SESSION.linesRemoved ?? 0,
};
const CACHE_WRITE_TTL = deriveCacheWriteTtlBreakdown(
  SESSION_DESIGN_SESSION.tokenUsageByModel
);
const SESSION_COST_USD = SESSION_DESIGN_SESSION.estimatedCost ?? 0;

export const SESSION_DESIGN_DETAILS_INPUT: SessionDetailsTabInput = {
  name: SESSION_DESIGN_SESSION.name ?? SESSION_DESIGN_SESSION.id,
  slug: SESSION_DESIGN_ARTIFACT.slug,
  sessionId:
    SESSION_DESIGN_SESSION.externalSessionId ?? SESSION_DESIGN_SESSION.id,
  // The displayed status, as the header's badge reads it.
  status: resolveSessionDetailDisplayStatus({
    awaitingInputSince: SESSION_DESIGN_SESSION.awaitingInputSince,
    endedAt: SESSION_DESIGN_SESSION.endedAt,
    lastActivityAt: SESSION_DESIGN_SESSION.lastActivityAt,
    startedAt: SESSION_DESIGN_SESSION.startedAt,
    status: SESSION_DESIGN_SESSION.status,
  }),
  owner: SESSION_DESIGN_ARTIFACT.owner,
  // The people the tab row's avatars show.
  collaborators: SESSION_DESIGN_ARTIFACT.collaborators,
  // The session's user, who is also the artifact's owner here.
  createdBy: SESSION_DESIGN_ARTIFACT.owner,
  createdAt: iso(SESSION_DESIGN_SESSION.startedAt),
  updatedAt: iso(SESSION_DESIGN_SESSION.updatedAt),
  autonomy: `${SESSION_DESIGN_SESSION.autonomy}%`,
  harness: SESSION_DESIGN_SESSION.harness ?? "",
  model: SESSION_DESIGN_SESSION.model ?? "",
  repository: SESSION_DESIGN_SESSION.repositoryFullName ?? "",
  // None in this fixture: the empty-row rule leaves the row out.
  otherRepositories: [],
  startedAt: iso(SESSION_DESIGN_SESSION.startedAt),
  lastActiveAt: iso(SESSION_DESIGN_SESSION.lastActivityAt),
  duration: {
    evidence: "Fixture: first to last event, 12:00 → 12:20",
    text: SESSION_DESIGN_SESSION.wallClock ?? "",
  },
  inputTokens: SESSION_DESIGN_SESSION.inputTokens ?? 0,
  outputTokens: SESSION_DESIGN_SESSION.outputTokens ?? 0,
  cacheReadTokens: SESSION_DESIGN_SESSION.cacheReadTokens ?? 0,
  cacheWriteTokens: SESSION_DESIGN_SESSION.cacheWriteTokens ?? 0,
  cost: formatCostPrecise(SESSION_DESIGN_SESSION.estimatedCost ?? undefined),
  // As the page's artifact has them: no project (so no custom fields), no
  // priority, no tags.
  project: SESSION_DESIGN_ARTIFACT.project,
  priority: null,
  tags: SESSION_DESIGN_ARTIFACT.tags,
  // The session's source artifact produced it; it produced its branch.
  associated: [
    ...(SESSION_DESIGN_SESSION.sourceArtifact
      ? [
          detailsAssociatedRecord({
            end: DetailsLinkEnd.Target,
            href: null,
            linkType: DetailsLinkType.Produces,
            name: SESSION_DESIGN_SESSION.sourceArtifact.name,
            slug:
              SESSION_DESIGN_SESSION.sourceArtifact.slug ??
              SESSION_DESIGN_SESSION.sourceArtifact.id,
          }),
        ]
      : []),
    ...(SESSION_DESIGN_SESSION.branch
      ? [
          detailsAssociatedRecord({
            end: DetailsLinkEnd.Source,
            href: null,
            linkType: DetailsLinkType.Produces,
            name: SESSION_DESIGN_SESSION.branch,
            slug: SESSION_DESIGN_SESSION.branch,
            type: "BR",
          }),
        ]
      : []),
  ],
  branches: SESSION_DESIGN_SESSION.branch
    ? [
        {
          id: SESSION_DESIGN_SESSION.branch,
          label: SESSION_DESIGN_SESSION.branch,
        },
      ]
    : [],
  // None in this fixture: the empty-row rule leaves the row out.
  pullRequests: [],
  // `agentCount` includes the main agent; the row counts subagents only.
  subagents: Math.max(0, (SESSION_DESIGN_SESSION.agentCount ?? 0) - 1),
  toolUses: SESSION_DESIGN_SESSION.toolUseCount ?? 0,
  errors: SESSION_DESIGN_SESSION.errorCount ?? 0,
  // Kerensa's reconciliation rows, where the page's session has a value. It has
  // no launch attribution or Codex runtime, so those rows are left out.
  linesChanged: LINES_CHANGED,
  cacheWriteTtl: CACHE_WRITE_TTL
    ? {
        fiveMinute: CACHE_WRITE_TTL.ephemeral5mInputTokens,
        oneHour: CACHE_WRITE_TTL.ephemeral1hInputTokens,
      }
    : undefined,
  locPerDollar:
    SESSION_COST_USD > 0
      ? formatLocPerDollar(
          (LINES_CHANGED.additions + LINES_CHANGED.deletions) / SESSION_COST_USD
        )
      : undefined,
  turns: SESSION_DESIGN_SESSION.turns ?? undefined,
  steers: SESSION_DESIGN_SESSION.steeringEpisodes ?? undefined,
};
