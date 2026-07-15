import { LinkType } from "@repo/api/src/types/artifact";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import type { BasicUser } from "@repo/api/src/types/user";
import type { Prisma, TransactionClient } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";
import type {
  AgentSessionListQuery,
  AgentSessionUsageQuery,
} from "../validators";

const computeTargetSummarySelect = {
  select: {
    id: true,
    machineName: true,
    isOnline: true,
    lastSeenAt: true,
  },
} as const;

const projectSummarySelect = {
  select: {
    id: true,
    name: true,
    slug: true,
  },
} as const;

export const sourceArtifactSummarySelect = {
  id: true,
  name: true,
  slug: true,
  type: true,
  subtype: true,
} satisfies Prisma.ArtifactSelect;

// Session detail rows are the CTI detail for SESSION artifacts: hoisted fields
// (name, status, slug, project, organizationId) live on the parent `artifact`
// relation and are selected through it.
const sessionArtifactSummarySelect = {
  select: {
    // Org SSOT (PRD-510 FR13) — selected so the by-id session read can run
    // resolveOrgScopeVia() against the session's parent Artifact (D4: the session
    // child tables are join-reached, so org is validated via the artifact here).
    organizationId: true,
    name: true,
    status: true,
    slug: true,
    project: projectSummarySelect,
    sourceLinks: {
      where: {
        linkType: LinkType.RelatesTo,
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionPr,
        },
      },
      orderBy: { createdAt: "asc" as const },
      select: {
        metadata: true,
        target: {
          select: {
            branch: {
              select: {
                repository: {
                  select: {
                    fullName: true,
                  },
                },
                currentPullRequestDetail: {
                  select: {
                    number: true,
                    title: true,
                    prState: true,
                    closedAt: true,
                    mergedAt: true,
                    lastVerifiedAt: true,
                    isCurrent: true,
                    // FEA-2732: producer-independent repo identity, present on
                    // repo-less (non-App) PRs where `repository` is null.
                    repositoryFullName: true,
                    repository: {
                      select: {
                        fullName: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ArtifactDefaultArgs;

export const agentSessionListSelect = {
  artifactId: true,
  externalSessionId: true,
  harness: true,
  origin: true,
  state: true,
  cwd: true,
  repositoryFullName: true,
  worktreePath: true,
  model: true,
  branch: true,
  pullRequests: true,
  wallClock: true,
  activeAgent: true,
  waitingUser: true,
  linesAdded: true,
  linesRemoved: true,
  filesChanged: true,
  locSource: true,
  branchLinesAdded: true,
  branchLinesRemoved: true,
  branchFilesChanged: true,
  branchLocSource: true,
  turns: true,
  steeringEpisodes: true,
  autonomy: true,
  activityBuckets: true,
  sessionSpan: true,
  markers: true,
  throttles: true,
  phases: true,
  phaseIterations: true,
  phaseLoopbacks: true,
  sessionStartedAt: true,
  sessionUpdatedAt: true,
  lastActivityAt: true,
  sessionEndedAt: true,
  awaitingInputSince: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  estimatedCost: true,
  agentCount: true,
  toolUseCount: true,
  errorCount: true,
  baseBranch: true,
  sourceArtifactId: true,
  sourceLoopId: true,
  user: basicUserSelect,
  computeTarget: computeTargetSummarySelect,
  artifact: sessionArtifactSummarySelect,
} satisfies Prisma.SessionDetailSelect;

export const agentSessionDetailSelect = {
  ...agentSessionListSelect,
  metadata: true,
  sourceArtifactId: true,
  sourceLoopId: true,
  tokenUsageByModel: {
    orderBy: {
      model: "asc",
    },
  },
  agents: true,
  events: {
    orderBy: [
      { eventCreatedAt: "asc" },
      { externalEventId: "asc" },
      { id: "asc" },
    ],
  },
  tracePhaseSources: true,
  throttleSources: true,
  correctionSources: true,
} satisfies Prisma.SessionDetailSelect;

export const agentSessionExportSelect = {
  sessionStartedAt: true,
  harness: true,
  model: true,
  deviceTimeZone: true,
  user: {
    select: {
      ...basicUserSelect.select,
      teamMemberships: {
        orderBy: {
          team: {
            name: "asc",
          },
        },
        select: {
          team: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  },
  artifact: {
    select: {
      project: {
        select: {
          name: true,
        },
      },
    },
  },
  tokenUsageByModel: {
    orderBy: {
      model: "asc",
    },
  },
} satisfies Prisma.SessionDetailSelect;

export const analyticsScalarSelect = {
  artifactId: true,
  repositoryFullName: true,
  inputTokens: true,
  outputTokens: true,
  estimatedCost: true,
  errorCount: true,
  artifact: {
    select: {
      projectId: true,
      project: projectSummarySelect,
    },
  },
} satisfies Prisma.SessionDetailSelect;

export const analyticsJsonSelect = {
  artifactId: true,
  agents: true,
  events: true,
} satisfies Prisma.SessionDetailSelect;

export type AgentSessionListRecord = Prisma.SessionDetailGetPayload<{
  select: typeof agentSessionListSelect;
}>;

export type AgentSessionDetailRecord = Prisma.SessionDetailGetPayload<{
  select: typeof agentSessionDetailSelect;
}>;

export type AgentSessionExportRecord = Prisma.SessionDetailGetPayload<{
  select: typeof agentSessionExportSelect;
}>;

export type SourceArtifactSummaryRecord = Prisma.ArtifactGetPayload<{
  select: typeof sourceArtifactSummarySelect;
}>;

export type AnalyticsScalarSessionRecord = Prisma.SessionDetailGetPayload<{
  select: typeof analyticsScalarSelect;
}>;

export type AnalyticsJsonSessionRecord = Prisma.SessionDetailGetPayload<{
  select: typeof analyticsJsonSelect;
}>;

export type AgentSessionUpsertTx = TransactionClient;

export type SessionProjectResolution = {
  artifactProjectById: Map<string, string>;
  loopProjectById: Map<string, string>;
  projectByRepositoryFullName: Map<string, string | null>;
};

export type AgentSessionScope = {
  organizationId: string;
};

export type SessionListInput = AgentSessionScope & {
  filters: AgentSessionListQuery;
};

export type SessionUsageInput = AgentSessionScope & {
  filters: AgentSessionUsageQuery;
};

export type SessionDetailInput = AgentSessionScope & {
  id: string;
};

export type UpsertSessionsContext = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  gatewaySessionId?: string;
};

export type SessionTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type LastSyncTargetRecord = {
  id: string;
  machineName: string;
  isOnline: boolean;
  lastSeenAt: Date;
  lastAgentSessionSyncAt: Date | null;
  user: BasicUser;
};
