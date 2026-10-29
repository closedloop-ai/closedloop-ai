import { InsightsScope } from "@repo/api/src/types/insights";
import { Prisma } from "@repo/database";

// Aggregation context resolved from the authenticated user + requested scope.
export type InsightsScopeContext = {
  organizationId: string;
  userId: string;
  /**
   * Clerk id of the requester, when the request carried one. Carried alongside
   * `userId` because it, not `userId`, is the distinct id a server-side PostHog
   * gate evaluates (`resolveDistinctIdsForIdentity`) — it is what the browser
   * identifies PostHog with, and a rollout targeted at Clerk ids never matches
   * an internal id. `userId` is the fallback for a principal carrying no Clerk
   * id (ISS-8196).
   */
  clerkUserId?: string | null;
  scope: InsightsScope;
  teamId?: string;
  // FEA-2745: IANA timezone the requester's daily buckets should be labelled
  // in, so the shared Insights charts bucket the same activity on the same
  // calendar day as the desktop shell (which buckets in the user's local
  // timezone via localDay(), FEA-2430). Undefined → UTC bucketing.
  timeZone?: string;
};

export type ArtifactScopeWhere = Prisma.ArtifactWhereInput;

export function isOrgScope(ctx: InsightsScopeContext): boolean {
  return ctx.scope === InsightsScope.Org;
}

/** Artifact-relation scope predicate (org-wide, or authored by the user). */
export function artifactScope(ctx: InsightsScopeContext): ArtifactScopeWhere {
  if (ctx.scope === InsightsScope.Me) {
    return { organizationId: ctx.organizationId, createdById: ctx.userId };
  }
  if (ctx.scope === InsightsScope.Team && !ctx.teamId) {
    return { organizationId: ctx.organizationId, id: { in: [] } };
  }
  if (ctx.scope === InsightsScope.Team && ctx.teamId) {
    return {
      organizationId: ctx.organizationId,
      createdBy: {
        teamMemberships: {
          some: {
            teamId: ctx.teamId,
          },
        },
      },
    };
  }
  return { organizationId: ctx.organizationId };
}

/** Session scope predicate (org-wide, or created by the user or a team
 * member). Both live on the parent artifact: the org since FEA-1699, and the
 * person since ISS-12251 D-4 moved "whose session" to Created by. */
export function sessionScope(
  ctx: InsightsScopeContext
): Prisma.SessionDetailWhereInput {
  const artifact: Prisma.ArtifactWhereInput = {
    organizationId: ctx.organizationId,
  };
  if (ctx.scope === InsightsScope.Me) {
    return { artifact: { is: { ...artifact, createdById: ctx.userId } } };
  }
  if (ctx.scope === InsightsScope.Team && !ctx.teamId) {
    return { artifact: { is: artifact }, artifactId: { in: [] } };
  }
  if (ctx.scope === InsightsScope.Team && ctx.teamId) {
    return {
      artifact: {
        is: {
          ...artifact,
          createdBy: {
            is: {
              teamMemberships: {
                some: {
                  teamId: ctx.teamId,
                },
              },
            },
          },
        },
      },
    };
  }
  return { artifact: { is: artifact } };
}

/**
 * Raw-SQL mirror of {@link sessionScope} for the event-volume aggregation, which
 * date-buckets in Postgres and so cannot use a Prisma relation filter. Emits a
 * WHERE condition over the `s` (session_detail) and `a` (artifacts) aliases the
 * caller joins. Keep the two scope predicates in lockstep.
 */
export function sessionScopeSql(ctx: InsightsScopeContext): Prisma.Sql {
  const org = Prisma.sql`a.organization_id = ${ctx.organizationId}::uuid`;
  if (ctx.scope === InsightsScope.Me) {
    return Prisma.sql`${org} AND a.created_by_id = ${ctx.userId}::uuid`;
  }
  if (ctx.scope === InsightsScope.Team && !ctx.teamId) {
    return Prisma.sql`false`;
  }
  if (ctx.scope === InsightsScope.Team && ctx.teamId) {
    return Prisma.sql`${org} AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.user_id = a.created_by_id AND tm.team_id = ${ctx.teamId}::uuid
    )`;
  }
  return org;
}
