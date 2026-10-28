import {
  SESSION_UNKNOWN_COST_BUCKET_ID,
  SessionChangePresenceId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { formatSessionSortRule } from "@repo/api/src/types/agent-session-sort";
import { Priority } from "@repo/api/src/types/common";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  type ListEmptinessClause,
  type ListFilterClause,
  ListFilterOperator,
  type ListFilterScalar,
  type ListIsAnyOfClause,
  type ListIsBetweenClause,
  type ListQueryExpression,
  ListSortDirection,
  type ListSortRule,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  PRIORITY_UNSET_VALUE,
  PRIORITY_VALUES,
} from "@repo/api/src/types/search-query";
import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import type { User } from "@repo/api/src/types/user";
import { type Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "../service";
import { agentSessionListQuerySchema } from "../validators";

/**
 * ISS-9477 against real Postgres: an expression request and its hand-written
 * legacy-param equivalent must lower to the SAME `findSessions` population and
 * order.
 *
 * The `list-query-lowering*.test.ts` unit suites prove the pure lowering
 * function maps one clause to one legacy param. They cannot prove the other
 * half — that the lowered params, run through the REAL `buildWhere` /
 * `buildAgentSessionOrderBy` against real rows, select and order the same set a
 * hand-written legacy request does. Only a real database, running
 * `findSessions` for both request shapes over one seeded population, can
 * disagree.
 *
 * Seeds are COMMITTED and torn down once in `afterAll` (not per test, and not
 * `autoRollbackTransaction`) because ~20 cases share one population — reseeding
 * per case would multiply the write cost for no isolation benefit, since every
 * case is read-only against the shared seed.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const MINUTE_MS = 60_000;

type RowLoc = {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
};

type RowSpec = {
  label: string;
  user: "A" | "B";
  status: SessionStatus;
  priority: Priority | null;
  harness: string;
  model: string | null;
  repositoryFullName: string | null;
  autonomy: number | null;
  estimatedCost: number | null;
  turns: number | null;
  loc: RowLoc | null;
  hasPr: boolean;
  lastActivityMinutesAgo: number;
  startedMinutesAgo: number;
};

/**
 * Twelve sessions spanning every filterable/sortable field the parity cases
 * below exercise. `lastActivityMinutesAgo` and `startedMinutesAgo` are
 * DELIBERATELY uncorrelated (and each independently shuffled) so the default
 * unsorted order (last-activity desc) never coincides with a "started" sort or
 * any other rule under test — see the non-vacuity comments on each case.
 */
const ROW_SPECS: readonly RowSpec[] = [
  {
    label: "r01",
    user: "A",
    status: SESSION_STATUS.ACTIVE,
    priority: Priority.High,
    harness: "claude",
    model: "claude-3",
    repositoryFullName: "org/repo-a",
    autonomy: 90,
    estimatedCost: 5,
    turns: 10,
    loc: { linesAdded: 10, linesRemoved: 2, filesChanged: 1 },
    hasPr: true,
    lastActivityMinutesAgo: 10,
    startedMinutesAgo: 100,
  },
  {
    label: "r02",
    user: "A",
    status: SESSION_STATUS.ACTIVE,
    priority: Priority.Low,
    harness: "aider",
    model: "gpt-4",
    repositoryFullName: "org/repo-b",
    autonomy: 50,
    estimatedCost: 5,
    turns: 5,
    loc: { linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    hasPr: false,
    lastActivityMinutesAgo: 20,
    startedMinutesAgo: 15,
  },
  {
    label: "r03",
    user: "B",
    status: SESSION_STATUS.INACTIVE,
    priority: Priority.Urgent,
    harness: "claude",
    model: null,
    repositoryFullName: null,
    autonomy: 20,
    estimatedCost: 15,
    turns: null,
    loc: { linesAdded: 5, linesRemoved: 0, filesChanged: 1 },
    hasPr: true,
    lastActivityMinutesAgo: 30,
    startedMinutesAgo: 300,
  },
  {
    label: "r04",
    user: "B",
    status: SESSION_STATUS.ERROR,
    priority: null,
    harness: "aider",
    model: "gpt-4",
    repositoryFullName: "org/repo-a",
    autonomy: null,
    estimatedCost: 0.5,
    turns: null,
    loc: { linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    hasPr: false,
    lastActivityMinutesAgo: 60,
    startedMinutesAgo: 65,
  },
  {
    label: "r05",
    user: "A",
    status: SESSION_STATUS.ACTIVE,
    priority: Priority.Medium,
    harness: "claude",
    model: "claude-3",
    repositoryFullName: "org/repo-c",
    autonomy: 95,
    estimatedCost: 100,
    turns: 20,
    loc: { linesAdded: 1, linesRemoved: 1, filesChanged: 1 },
    hasPr: true,
    lastActivityMinutesAgo: 5,
    startedMinutesAgo: 250,
  },
  {
    label: "r06",
    user: "A",
    status: SESSION_STATUS.INACTIVE,
    priority: Priority.High,
    harness: "aider",
    model: null,
    repositoryFullName: "org/repo-b",
    autonomy: 40,
    estimatedCost: 2,
    turns: 3,
    loc: { linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    hasPr: false,
    lastActivityMinutesAgo: 45,
    startedMinutesAgo: 50,
  },
  {
    label: "r07",
    user: "B",
    status: SESSION_STATUS.ACTIVE,
    priority: Priority.Low,
    harness: "claude",
    model: "gpt-4",
    repositoryFullName: null,
    autonomy: 10,
    estimatedCost: 0.2,
    turns: null,
    loc: { linesAdded: 2, linesRemoved: 0, filesChanged: 1 },
    hasPr: false,
    lastActivityMinutesAgo: 90,
    startedMinutesAgo: 8,
  },
  {
    label: "r08",
    user: "B",
    status: SESSION_STATUS.ERROR,
    priority: Priority.Urgent,
    harness: "aider",
    model: "claude-3",
    repositoryFullName: "org/repo-a",
    autonomy: null,
    estimatedCost: null,
    turns: 1,
    loc: { linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    hasPr: true,
    lastActivityMinutesAgo: 120,
    startedMinutesAgo: 130,
  },
  {
    label: "r09",
    user: "A",
    status: SESSION_STATUS.ACTIVE,
    priority: null,
    harness: "claude",
    model: "claude-3",
    repositoryFullName: "org/repo-b",
    autonomy: 75,
    estimatedCost: 8,
    turns: 2,
    loc: { linesAdded: 3, linesRemoved: 3, filesChanged: 2 },
    hasPr: true,
    lastActivityMinutesAgo: 2,
    startedMinutesAgo: 400,
  },
  {
    label: "r10",
    user: "A",
    status: SESSION_STATUS.INACTIVE,
    priority: Priority.Medium,
    harness: "aider",
    model: "gpt-4",
    repositoryFullName: null,
    autonomy: 60,
    estimatedCost: 1,
    turns: null,
    loc: { linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    hasPr: false,
    lastActivityMinutesAgo: 150,
    startedMinutesAgo: 12,
  },
  {
    label: "r11",
    user: "B",
    status: SESSION_STATUS.ACTIVE,
    priority: Priority.High,
    harness: "claude",
    model: null,
    repositoryFullName: "org/repo-c",
    autonomy: null,
    estimatedCost: 50,
    turns: 7,
    loc: { linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    hasPr: false,
    lastActivityMinutesAgo: 3,
    startedMinutesAgo: 500,
  },
  {
    label: "r12",
    user: "B",
    status: SESSION_STATUS.ERROR,
    priority: Priority.Low,
    harness: "aider",
    model: "gpt-4",
    repositoryFullName: "org/repo-a",
    autonomy: 5,
    estimatedCost: null,
    turns: null,
    loc: { linesAdded: 1, linesRemoved: 0, filesChanged: 1 },
    hasPr: true,
    lastActivityMinutesAgo: 200,
    startedMinutesAgo: 6,
  },
];

const committedOrganizations = createCommittedTestOrganizationTracker();
let organizationId: string;
let populationTotal: number;
let userAId: string;

describeIfDb(
  "Sessions listQuery lowering against real Postgres (ISS-9477)",
  () => {
    beforeAll(async () => {
      organizationId = await committedOrganizations.create();
      const userA = await createTestUser(organizationId);
      const userB = await createTestUser(organizationId);
      userAId = userA.id;
      const users = { A: userA, B: userB };
      const now = Date.now();
      for (const spec of ROW_SPECS) {
        await seedRow(organizationId, now, users[spec.user], spec);
      }
      const population = await findLegacy(organizationId, { quality: "all" });
      populationTotal = population.total;
    });

    afterAll(() => committedOrganizations.cleanup());

    it("holds population steady at the seeded row count", () => {
      expect(populationTotal).toBe(ROW_SPECS.length);
    });

    // One `it.each` case per capability field the seed can express. Every
    // `expect()` lives directly in the `it.each` callback — Biome's
    // `noMisplacedAssertion` refuses one inside any other function, which is
    // also why `fetchFilterCase`/`fetchSortCase` below only fetch, never assert.
    it.each(FILTER_CASES)("filters by $name", async ({ build }) => {
      const { legacyParams, exprFilters } = build();
      const { legacy, expression } = await fetchFilterCase(
        legacyParams,
        exprFilters
      );
      expect(idsOf(expression)).toEqual(idsOf(legacy));
      expect(expression.total).toBe(legacy.total);
      expect(legacy.total).toBeGreaterThan(0);
      expect(legacy.total).toBeLessThan(populationTotal);
    });

    it("filters by quality", async () => {
      const legacy = await findLegacy(organizationId, {
        quality: "substantive",
      });
      const expression = await findExpression(organizationId, {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [anyOfClause(SessionListField.Quality, ["substantive"])],
      });
      expect(idsOf(expression)).toEqual(idsOf(legacy));
      expect(expression.total).toBe(legacy.total);
      expect(legacy.total).toBeGreaterThan(0);
      expect(legacy.total).toBeLessThan(populationTotal);
    });

    it.each(SORT_CASES)(
      "sorts by $name",
      async ({ legacySortParams, exprSorts }) => {
        const { legacy, expression, unsorted } = await fetchSortCase(
          legacySortParams,
          exprSorts
        );
        expect(idsOf(expression)).toEqual(idsOf(legacy));
        expect(expression.total).toBe(legacy.total);
        expect(idsOf(legacy)).not.toEqual(idsOf(unsorted));
      }
    );

    it("filters and sorts together (compound)", async () => {
      const legacyFilterParams = {
        statuses: [SESSION_STATUS.ACTIVE],
        autonomyTiers: ["high"],
      };
      const exprFilters = [
        anyOfClause(SessionListField.Status, [SESSION_STATUS.ACTIVE]),
        anyOfClause(SessionListField.Autonomy, ["high"]),
      ];
      const { legacy, expression, unsorted } = await fetchSortCase(
        {
          ...legacyFilterParams,
          sortBy: SessionListField.Cost,
          sortDir: ListSortDirection.Desc,
        },
        [sortRule(SessionListField.Cost, ListSortDirection.Desc)],
        { legacyFilterParams, exprFilters }
      );
      expect(idsOf(expression)).toEqual(idsOf(legacy));
      expect(expression.total).toBe(legacy.total);
      expect(idsOf(legacy)).not.toEqual(idsOf(unsorted));
      expect(legacy.total).toBeGreaterThan(0);
      expect(legacy.total).toBeLessThan(populationTotal);
    });
  }
);

/** Parse `raw` as a legacy request and run it against the real `findSessions`. */
async function findLegacy(orgId: string, raw: Record<string, unknown>) {
  const filters = agentSessionListQuerySchema.parse(raw);
  return await agentSessionsService.findSessions({
    organizationId: orgId,
    filters,
  });
}

/** Serialize `expression` as the `listQuery` param and run it the same way. */
async function findExpression(orgId: string, expression: ListQueryExpression) {
  const filters = agentSessionListQuerySchema.parse({
    [LIST_QUERY_EXPRESSION_PARAM]: JSON.stringify(expression),
  });
  return await agentSessionsService.findSessions({
    organizationId: orgId,
    filters,
  });
}

function idsOf(result: { items: { id: string }[] }): string[] {
  return result.items.map((item) => item.id);
}

function qualityAllClause(): ListIsAnyOfClause {
  return anyOfClause(SessionListField.Quality, ["all"]);
}

type FilterCase = {
  name: string;
  /**
   * Lazy: `userAId` (used by the "user" case) is only assigned inside
   * `beforeAll`, which runs AFTER this array literal is constructed while
   * `describeIfDb`'s body executes. Deferring the lookup into a closure, called
   * from inside the `it.each` callback, reads the value `beforeAll` set rather
   * than the `undefined` it held at describe-time.
   */
  build: () => {
    legacyParams: Record<string, unknown>;
    exprFilters: readonly ListFilterClause[];
  };
};

/** One case per {@link CLOUD_SESSION_LIST_QUERY_CAPABILITY} field the seed can express, minus `quality` (asserted separately below with a different population check). */
const FILTER_CASES: readonly FilterCase[] = [
  {
    name: "status",
    build: () => ({
      legacyParams: { statuses: [SESSION_STATUS.ACTIVE] },
      exprFilters: [
        anyOfClause(SessionListField.Status, [SESSION_STATUS.ACTIVE]),
      ],
    }),
  },
  {
    name: "user",
    build: () => ({
      legacyParams: { userIds: [userAId] },
      exprFilters: [anyOfClause(SessionListField.User, [userAId])],
    }),
  },
  {
    name: "repo",
    build: () => ({
      legacyParams: { repositories: ["org/repo-a"] },
      exprFilters: [anyOfClause(SessionListField.Repo, ["org/repo-a"])],
    }),
  },
  {
    name: "harness",
    build: () => ({
      legacyParams: { harnesses: ["claude"] },
      exprFilters: [anyOfClause(SessionListField.Harness, ["claude"])],
    }),
  },
  {
    name: "model",
    build: () => ({
      legacyParams: { models: ["claude-3"] },
      exprFilters: [anyOfClause(SessionListField.Model, ["claude-3"])],
    }),
  },
  {
    name: "autonomy tier",
    build: () => ({
      legacyParams: { autonomyTiers: ["high"] },
      exprFilters: [anyOfClause(SessionListField.Autonomy, ["high"])],
    }),
  },
  {
    name: "autonomy isEmpty",
    build: () => ({
      legacyParams: { autonomyTiers: ["unknown"] },
      exprFilters: [emptyClause(SessionListField.Autonomy)],
    }),
  },
  {
    name: "cost bucket",
    build: () => ({
      legacyParams: { costBuckets: ["under_1"] },
      exprFilters: [anyOfClause(SessionListField.Cost, ["under_1"])],
    }),
  },
  {
    name: "cost isEmpty",
    build: () => ({
      legacyParams: { costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID] },
      exprFilters: [emptyClause(SessionListField.Cost)],
    }),
  },
  {
    name: "priority",
    build: () => ({
      legacyParams: { priorities: [Priority.High] },
      exprFilters: [anyOfClause(SessionListField.Priority, [Priority.High])],
    }),
  },
  {
    name: "priority isEmpty",
    build: () => ({
      legacyParams: { priorities: [PRIORITY_UNSET_VALUE] },
      exprFilters: [emptyClause(SessionListField.Priority)],
    }),
  },
  {
    name: "priority isNotEmpty",
    build: () => ({
      legacyParams: { priorities: [...PRIORITY_VALUES] },
      exprFilters: [notEmptyClause(SessionListField.Priority)],
    }),
  },
  {
    name: "lastActivity isBetween",
    build: () => {
      const now = Date.now();
      const min = new Date(now - 35 * MINUTE_MS).toISOString();
      const max = new Date(now).toISOString();
      return {
        legacyParams: { startDate: min, endDate: max },
        exprFilters: [betweenClause(SessionListField.LastActivity, min, max)],
      };
    },
  },
  {
    name: "changePresence",
    build: () => ({
      legacyParams: { changePresence: [SessionChangePresenceId.HasChanges] },
      exprFilters: [
        anyOfClause(SessionListField.ChangePresence, [
          SessionChangePresenceId.HasChanges,
        ]),
      ],
    }),
  },
  {
    name: "prAssociation",
    build: () => ({
      legacyParams: { prAssociation: [SessionPrAssociationId.HasPr] },
      exprFilters: [
        anyOfClause(SessionListField.PrAssociation, [
          SessionPrAssociationId.HasPr,
        ]),
      ],
    }),
  },
];

type SortCase = {
  name: string;
  legacySortParams: Record<string, unknown>;
  exprSorts: readonly ListSortRule[];
};

/** One single-rule case per DB-sortable column, plus one multi-rule case. */
const SORT_CASES: readonly SortCase[] = [
  {
    name: "cost ascending",
    legacySortParams: {
      sortBy: SessionListField.Cost,
      sortDir: ListSortDirection.Asc,
    },
    exprSorts: [sortRule(SessionListField.Cost, ListSortDirection.Asc)],
  },
  {
    name: "cost descending",
    legacySortParams: {
      sortBy: SessionListField.Cost,
      sortDir: ListSortDirection.Desc,
    },
    exprSorts: [sortRule(SessionListField.Cost, ListSortDirection.Desc)],
  },
  {
    name: "started",
    legacySortParams: {
      sortBy: SessionListField.Started,
      sortDir: ListSortDirection.Desc,
    },
    exprSorts: [sortRule(SessionListField.Started, ListSortDirection.Desc)],
  },
  {
    name: "priority",
    legacySortParams: {
      sortBy: SessionListField.Priority,
      sortDir: ListSortDirection.Desc,
    },
    exprSorts: [sortRule(SessionListField.Priority, ListSortDirection.Desc)],
  },
  {
    name: "status",
    legacySortParams: {
      sortBy: SessionListField.Status,
      sortDir: ListSortDirection.Asc,
    },
    exprSorts: [sortRule(SessionListField.Status, ListSortDirection.Asc)],
  },
  {
    name: "status then cost (multi-rule)",
    legacySortParams: {
      sorts: [
        formatSessionSortRule(SessionListField.Status, ListSortDirection.Asc),
        formatSessionSortRule(SessionListField.Cost, ListSortDirection.Desc),
      ],
    },
    exprSorts: [
      sortRule(SessionListField.Status, ListSortDirection.Asc),
      sortRule(SessionListField.Cost, ListSortDirection.Desc),
    ],
  },
];

type FilterCaseResult = {
  legacy: AgentSessionListResponse;
  expression: AgentSessionListResponse;
};

/**
 * Fetch one filter-parity case: the legacy raw params and the equivalent
 * expression clauses (both carrying an explicit `quality: "all"`, per the
 * ISS-9477 companion-param rule — `listQuery` refuses a request that ALSO
 * sends a legacy field param, so quality travels as an expression clause,
 * never alongside `listQuery`). Returns data only — every `expect()` lives in
 * the calling `it`/`it.each` body; Biome's `noMisplacedAssertion` refuses one
 * inside any other function.
 */
async function fetchFilterCase(
  legacyFilterParams: Record<string, unknown>,
  exprFilters: readonly ListFilterClause[]
): Promise<FilterCaseResult> {
  const legacy = await findLegacy(organizationId, {
    quality: "all",
    ...legacyFilterParams,
  });
  const expression = await findExpression(organizationId, {
    version: LIST_QUERY_EXPRESSION_VERSION,
    filters: [...exprFilters, qualityAllClause()],
  });
  return { legacy, expression };
}

type SortCaseResult = {
  legacy: AgentSessionListResponse;
  expression: AgentSessionListResponse;
  unsorted: AgentSessionListResponse;
};

/**
 * Fetch one sort-parity case, plus the DEFAULT (unsorted) read of the same
 * filtered population. Returns data only, for the same reason
 * {@link fetchFilterCase} does.
 */
async function fetchSortCase(
  legacySortParams: Record<string, unknown>,
  exprSorts: readonly ListSortRule[],
  filters?: {
    legacyFilterParams: Record<string, unknown>;
    exprFilters: readonly ListFilterClause[];
  }
): Promise<SortCaseResult> {
  const legacyFilterParams = filters?.legacyFilterParams ?? {};
  const exprFilters = filters?.exprFilters ?? [];
  const legacy = await findLegacy(organizationId, {
    quality: "all",
    ...legacyFilterParams,
    ...legacySortParams,
  });
  const expression = await findExpression(organizationId, {
    version: LIST_QUERY_EXPRESSION_VERSION,
    filters: [...exprFilters, qualityAllClause()],
    sorts: [...exprSorts],
  });
  const unsorted = await findLegacy(organizationId, {
    quality: "all",
    ...legacyFilterParams,
  });
  return { legacy, expression, unsorted };
}

function anyOfClause(
  field: SessionListField,
  values: readonly ListFilterScalar[]
): ListIsAnyOfClause {
  return { field, operator: ListFilterOperator.IsAnyOf, values: [...values] };
}

function emptyClause(field: SessionListField): ListEmptinessClause {
  return { field, operator: ListFilterOperator.IsEmpty };
}

function notEmptyClause(field: SessionListField): ListEmptinessClause {
  return { field, operator: ListFilterOperator.IsNotEmpty };
}

function betweenClause(
  field: SessionListField,
  min: ListFilterScalar,
  max: ListFilterScalar
): ListIsBetweenClause {
  return { field, operator: ListFilterOperator.IsBetween, min, max };
}

function sortRule(
  field: SessionListField,
  direction: ListSortDirection
): ListSortRule {
  return { field, direction };
}

/**
 * Seed one session artifact + `SessionDetail` row, then patch the columns
 * `createTestSessionDetail` does not accept (harness override, model, repo,
 * autonomy, turns, LOC, PR json) plus the artifact's `priority`.
 */
async function seedRow(
  orgId: string,
  now: number,
  user: User,
  spec: RowSpec
): Promise<string> {
  const artifactId = await createTestSessionDetail({
    organizationId: orgId,
    userId: user.id,
    label: spec.label,
    status: spec.status,
    sessionTimestamp: new Date(now - spec.startedMinutesAgo * MINUTE_MS),
    lastActivityAt: new Date(now - spec.lastActivityMinutesAgo * MINUTE_MS),
    cost: { estimatedCost: spec.estimatedCost },
  });
  await withDb((db) =>
    db.sessionDetail.update({
      where: { artifactId },
      data: {
        harness: spec.harness,
        model: spec.model,
        repositoryFullName: spec.repositoryFullName,
        autonomy: spec.autonomy,
        turns: spec.turns,
        linesAdded: spec.loc?.linesAdded ?? null,
        linesRemoved: spec.loc?.linesRemoved ?? null,
        filesChanged: spec.loc?.filesChanged ?? null,
        pullRequests: spec.hasPr
          ? ([
              { number: 1, url: "https://example.com/pr/1" },
            ] as Prisma.InputJsonValue)
          : undefined,
      },
      select: { artifactId: true },
    })
  );
  if (spec.priority) {
    await withDb((db) =>
      db.artifact.update({
        where: { id: artifactId },
        data: { priority: spec.priority },
      })
    );
  }
  return artifactId;
}
