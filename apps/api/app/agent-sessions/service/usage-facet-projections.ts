import type {
  AgentSessionUsageByModel,
  AgentSessionUsageByUser,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionRepositoryBreakdown } from "@repo/api/src/types/agent-session-usage-breakdown";
import type { BasicUser } from "@repo/api/src/types/user";
import { toNumber } from "@/lib/prisma-number";
import { displayUserName } from "@/lib/user-display-name";

/**
 * Shape the Sessions usage-summary `groupBy` aggregates into the facet payload
 * the Sessions surface renders (Owner, Model, Harness, Repository breakdowns).
 *
 * Extracted from `service.ts` (ISS-5283): that file is grandfathered over the
 * 1,000-line ceiling and is SHRINK-ONLY, and this is a genuinely separate
 * responsibility — `getUsageSummary` decides WHICH population each aggregate
 * runs over (see `facet-count-where.ts`), while these decide how a raw group row
 * becomes a facet option. Splitting them also makes the ordering rules below
 * directly testable without standing up the whole summary read.
 *
 * Every projection here is pure: no DB access, no `where` knowledge.
 */

/**
 * The shape `toNumber` accepts: a Prisma `Decimal`/`BigInt` sum, a plain number,
 * or null when the group had no rows to sum. Declared once here rather than
 * typing these fields `unknown` — `unknown` would compile only behind casts,
 * and the point of narrowing at this boundary is to not need them.
 */
type PrismaNumeric = Parameters<typeof toNumber>[0];

type CountAndTokenSums = {
  _count: { _all: number };
  _sum: {
    inputTokens: PrismaNumeric;
    outputTokens: PrismaNumeric;
    cacheReadTokens?: PrismaNumeric;
    cacheWriteTokens?: PrismaNumeric;
    estimatedCost: PrismaNumeric;
  };
};

type ByUserGroup = CountAndTokenSums & { userId: string | null };
type ByModelGroup = CountAndTokenSums & { model: string };
type ByHarnessGroup = CountAndTokenSums & { harness: string };
type ByRepositoryGroup = {
  repositoryFullName: string | null;
  _count: { _all: number };
  _sum: {
    inputTokens: PrismaNumeric;
    outputTokens: PrismaNumeric;
    estimatedCost: PrismaNumeric;
    errorCount?: number | null;
  };
};

/**
 * Owner facet. Groups whose user could not be resolved are dropped — an owner
 * option that cannot be labelled is not one the user can act on.
 *
 * FEA-3452: sorted by session count desc — the one canonical order shared with
 * desktop's `buildByUserRollup`/`buildByUserFromCounts`. The desktop fast path
 * has no per-owner cost, so session-count desc is the portable key; sorting by
 * `estimatedCost` here listed owners differently on cloud vs desktop for the
 * same facet.
 */
export function buildUsageByUser(
  groups: readonly ByUserGroup[],
  usersById: ReadonlyMap<string, BasicUser>
): AgentSessionUsageByUser[] {
  return groups
    .map((group) => {
      const user = group.userId ? usersById.get(group.userId) : null;
      if (!user) {
        return null;
      }
      return {
        userId: user.id,
        userName: displayUserName(user),
        userEmail: user.email,
        userAvatarUrl: user.avatarUrl,
        sessionCount: group._count._all,
        inputTokens: toNumber(group._sum.inputTokens),
        outputTokens: toNumber(group._sum.outputTokens),
        cacheReadTokens: toNumber(group._sum.cacheReadTokens),
        cacheWriteTokens: toNumber(group._sum.cacheWriteTokens),
        estimatedCost: toNumber(group._sum.estimatedCost),
      };
    })
    .filter((value): value is AgentSessionUsageByUser => value != null)
    .sort((left, right) => right.sessionCount - left.sessionCount);
}

/**
 * The COST lens by model — spans every model a session used, including subagent
 * models, and is sorted by spend because that is the question it answers.
 * Deliberately NOT the Model facet: that is `buildModelFilterOptions`, keyed to
 * the primary displayed model so the facet can never offer a value the table's
 * Model column cannot show (FEA-4303).
 */
export function buildUsageByModel(
  groups: readonly ByModelGroup[]
): AgentSessionUsageByModel[] {
  return groups
    .map((group) => ({
      model: group.model,
      sessionCount: group._count._all,
      inputTokens: toNumber(group._sum.inputTokens),
      outputTokens: toNumber(group._sum.outputTokens),
      cacheReadTokens: toNumber(group._sum.cacheReadTokens),
      cacheWriteTokens: toNumber(group._sum.cacheWriteTokens),
      estimatedCost: toNumber(group._sum.estimatedCost),
    }))
    .sort((left, right) => right.estimatedCost - left.estimatedCost);
}

/** Harness facet, session-count desc to match the other facet orders. */
export function buildUsageByHarness(groups: readonly ByHarnessGroup[]) {
  return groups
    .map((group) => ({
      harness: group.harness,
      sessionCount: group._count._all,
      inputTokens: toNumber(group._sum.inputTokens),
      outputTokens: toNumber(group._sum.outputTokens),
      cacheReadTokens: toNumber(group._sum.cacheReadTokens),
      cacheWriteTokens: toNumber(group._sum.cacheWriteTokens),
      estimatedCost: toNumber(group._sum.estimatedCost),
    }))
    .sort((left, right) => right.sessionCount - left.sessionCount);
}

/**
 * Repository facet (Filter → Repository). Sessions with no captured repository
 * (null) are dropped: there is nothing to filter to, so offering the option
 * would be an affordance that cannot narrow anything.
 */
export function buildUsageByRepository(
  groups: readonly ByRepositoryGroup[] | undefined
): AgentSessionRepositoryBreakdown[] {
  return (groups ?? [])
    .filter(
      (group): group is ByRepositoryGroup & { repositoryFullName: string } =>
        group.repositoryFullName != null
    )
    .map((group) => ({
      repositoryFullName: group.repositoryFullName,
      sessionCount: group._count._all,
      inputTokens: toNumber(group._sum.inputTokens),
      outputTokens: toNumber(group._sum.outputTokens),
      estimatedCost: toNumber(group._sum.estimatedCost),
      errorCount: group._sum.errorCount ?? 0,
    }))
    .sort((left, right) => right.sessionCount - left.sessionCount);
}
