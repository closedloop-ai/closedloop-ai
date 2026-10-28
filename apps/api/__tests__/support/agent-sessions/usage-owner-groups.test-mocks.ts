import { type Mock, vi } from "vitest";
import { z } from "zod";

/** One Owner's sums, as `readUsageGroupsByAssignee` reads them. */
export type UsageOwnerGroupFixture = {
  userId: string;
  _count: { _all: number };
  _sum: Record<string, number | null>;
};

const perAssigneeWhereSchema = z.object({
  where: z.object({
    AND: z.tuple([
      z.unknown(),
      z.object({
        artifact: z.object({ is: z.object({ assigneeId: z.string() }) }),
      }),
    ]),
  }),
});

/**
 * ISS-12251: mocks for the usage summary's Owner breakdown, which lists the
 * population's assignees with `artifact.groupBy` and then reads each one's sums
 * with a `sessionDetail.aggregate` scoped to that assignee. `aggregate`
 * answers those per-assignee calls from `groups`, and hands every other call
 * (the headline totals, a prior period) to `otherCalls`.
 */
export function usageOwnerGroupMocks(
  otherCalls: (args: unknown) => unknown,
  groups: readonly UsageOwnerGroupFixture[]
): {
  artifactGroupBy: Mock;
  aggregate: Mock<(args: unknown) => Promise<unknown>>;
} {
  const byAssignee = new Map(groups.map((group) => [group.userId, group]));
  return {
    artifactGroupBy: vi
      .fn()
      .mockResolvedValue(groups.map((group) => ({ assigneeId: group.userId }))),
    aggregate: vi.fn((args: unknown) => {
      const assigneeId = perAssigneeAggregateOwner(args);
      const group =
        assigneeId === undefined ? undefined : byAssignee.get(assigneeId);
      return group
        ? Promise.resolve({ _count: group._count, _sum: group._sum })
        : Promise.resolve(otherCalls(args));
    }),
  };
}

/** The assignee a per-Owner `sessionDetail.aggregate` call is scoped to, if it is one. */
export function perAssigneeAggregateOwner(args: unknown): string | undefined {
  const parsed = perAssigneeWhereSchema.safeParse(args);
  return parsed.success
    ? parsed.data.where.AND[1].artifact.is.assigneeId
    : undefined;
}
