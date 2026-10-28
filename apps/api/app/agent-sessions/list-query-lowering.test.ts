/**
 * ISS-9477 — the cloud Sessions compiler. A `listQuery` expression is lowered
 * to the legacy params and parsed by the same schema, so for every field and
 * operator the cloud declares, the expression and its hand-written legacy
 * equivalent must reach `buildWhere` and `buildAgentSessionOrderBy` as the
 * same request. The legacy side of every row is written out by hand, never
 * derived from the lowering, so a lowering that writes the wrong param or the
 * wrong values fails its row.
 */
import {
  SESSION_COST_BUCKETS,
  SESSION_UNKNOWN_COST_BUCKET_ID,
  SessionChangePresenceId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import { SESSION_AUTONOMY_TIER_FILTER_OPTIONS } from "@repo/api/src/session-autonomy-tiers";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { SESSION_LIST_MAX_LIMIT } from "@repo/api/src/types/agent-session-list-limits";
import {
  LIST_QUERY_EXPRESSION_MAX_LENGTH,
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  LIST_QUERY_MAX_CLAUSES,
  LIST_QUERY_MAX_SORT_RULES,
  type ListFilterClause,
  ListFilterOperator,
  type ListQueryExpression,
  ListQueryRefusal,
  type ListQueryRefused,
  ListSortDirection,
  type ListSortRule,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  PRIORITY_UNSET_VALUE,
  PRIORITY_VALUES,
} from "@repo/api/src/types/search-query";
import { CLOUD_SESSION_LIST_QUERY_CAPABILITY } from "@repo/api/src/types/session-list-query-capabilities";
import { lowerSessionListQueryExpression } from "@repo/api/src/types/session-list-query-lowering";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it, vi } from "vitest";
import { listQueryRefusalMetadata } from "./list-query-param";
import { buildAgentSessionOrderBy, buildWhere } from "./service/query-builder";
import {
  AGENT_SESSION_SORT_COLUMNS,
  agentSessionListQuerySchema,
  agentSessionStatusCountsQuerySchema,
  agentSessionUsageQuerySchema,
  baseAgentSessionQuerySchema,
} from "./validators";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

const SCOPE = { organizationId: "org-1", viewerId: "viewer-1" };
const USER_ID = "01a07463-31f5-773e-9fa9-bd1dbdac9f1b";
const PROJECT_ID = "0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9";
const TEAM_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";
const REPO = "closedloop-ai/closedloop-ai";
const WINDOW_START = "2026-09-01T00:00:00.000Z";
const WINDOW_END = "2026-09-24T23:59:59.999Z";

const AUTONOMY_UNKNOWN = "unknown";
const KNOWN_AUTONOMY_TIER = requireDefined(
  SESSION_AUTONOMY_TIER_FILTER_OPTIONS.find(
    (option) => option.value !== AUTONOMY_UNKNOWN
  )
).value;
const COST_BUCKET = requireDefined(SESSION_COST_BUCKETS[0]).id;
const [PRIORITY_MEMBER] = PRIORITY_VALUES;

type RawParams = Record<string, string | string[]>;

type EquivalenceRow = {
  /** `<field>:<operator>`, plus `+includeEmpty` when the row states it true. */
  covers: string;
  expression: ListFilterClause;
  legacy: RawParams;
};

const anyOf = (
  field: SessionListField,
  values: (string | number)[],
  includeEmpty?: boolean
): ListFilterClause => ({
  field,
  operator: ListFilterOperator.IsAnyOf,
  values,
  ...(includeEmpty === undefined ? {} : { includeEmpty }),
});
const emptiness = (
  field: SessionListField,
  operator:
    | typeof ListFilterOperator.IsEmpty
    | typeof ListFilterOperator.IsNotEmpty
): ListFilterClause => ({ field, operator });

/**
 * One row per (field, operator) the cloud capability declares, plus each
 * served `includeEmpty: true`. `quality` is pinned beside every other row so
 * the FEA-3284 default cannot make two different requests look alike.
 */
const EQUIVALENCE_ROWS: readonly EquivalenceRow[] = [
  {
    covers: "user:isAnyOf",
    expression: anyOf(SessionListField.User, [USER_ID]),
    legacy: { userIds: USER_ID },
  },
  {
    covers: "status:isAnyOf",
    expression: anyOf(SessionListField.Status, [
      SESSION_STATUS.ACTIVE,
      SESSION_STATUS.ERROR,
    ]),
    legacy: { statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ERROR] },
  },
  {
    covers: "repo:isAnyOf",
    expression: anyOf(SessionListField.Repo, [REPO]),
    legacy: { repositories: REPO },
  },
  {
    covers: "harness:isAnyOf",
    expression: anyOf(SessionListField.Harness, ["claude", "codex"]),
    legacy: { harnesses: ["claude", "codex"] },
  },
  {
    covers: "model:isAnyOf",
    expression: anyOf(SessionListField.Model, ["claude-opus-5-5"]),
    legacy: { models: "claude-opus-5-5" },
  },
  {
    covers: "autonomy:isAnyOf",
    expression: anyOf(SessionListField.Autonomy, [KNOWN_AUTONOMY_TIER]),
    legacy: { autonomyTiers: KNOWN_AUTONOMY_TIER },
  },
  {
    covers: "autonomy:isAnyOf+includeEmpty",
    expression: anyOf(SessionListField.Autonomy, [KNOWN_AUTONOMY_TIER], true),
    legacy: { autonomyTiers: [KNOWN_AUTONOMY_TIER, AUTONOMY_UNKNOWN] },
  },
  {
    covers: "autonomy:isEmpty",
    expression: emptiness(
      SessionListField.Autonomy,
      ListFilterOperator.IsEmpty
    ),
    legacy: { autonomyTiers: AUTONOMY_UNKNOWN },
  },
  {
    covers: "cost:isAnyOf",
    expression: anyOf(SessionListField.Cost, [COST_BUCKET]),
    legacy: { costBuckets: COST_BUCKET },
  },
  {
    covers: "cost:isAnyOf+includeEmpty",
    expression: anyOf(SessionListField.Cost, [COST_BUCKET], true),
    legacy: { costBuckets: [COST_BUCKET, SESSION_UNKNOWN_COST_BUCKET_ID] },
  },
  {
    covers: "cost:isEmpty",
    expression: emptiness(SessionListField.Cost, ListFilterOperator.IsEmpty),
    legacy: { costBuckets: SESSION_UNKNOWN_COST_BUCKET_ID },
  },
  {
    covers: "priority:isAnyOf",
    expression: anyOf(SessionListField.Priority, [PRIORITY_MEMBER]),
    legacy: { priorities: PRIORITY_MEMBER },
  },
  {
    covers: "priority:isAnyOf+includeEmpty",
    expression: anyOf(SessionListField.Priority, [PRIORITY_MEMBER], true),
    legacy: { priorities: [PRIORITY_MEMBER, PRIORITY_UNSET_VALUE] },
  },
  {
    covers: "priority:isEmpty",
    expression: emptiness(
      SessionListField.Priority,
      ListFilterOperator.IsEmpty
    ),
    legacy: { priorities: PRIORITY_UNSET_VALUE },
  },
  {
    covers: "priority:isNotEmpty",
    expression: emptiness(
      SessionListField.Priority,
      ListFilterOperator.IsNotEmpty
    ),
    legacy: { priorities: [...PRIORITY_VALUES] },
  },
  {
    covers: "lastActivity:isBetween",
    expression: {
      field: SessionListField.LastActivity,
      operator: ListFilterOperator.IsBetween,
      min: WINDOW_START,
      max: WINDOW_END,
    },
    legacy: { startDate: WINDOW_START, endDate: WINDOW_END },
  },
  {
    covers: "changePresence:isAnyOf",
    expression: anyOf(SessionListField.ChangePresence, [
      SessionChangePresenceId.HasChanges,
    ]),
    legacy: { changePresence: SessionChangePresenceId.HasChanges },
  },
  {
    covers: "prAssociation:isAnyOf",
    expression: anyOf(SessionListField.PrAssociation, [
      SessionPrAssociationId.NoPr,
    ]),
    legacy: { prAssociation: SessionPrAssociationId.NoPr },
  },
  {
    covers: "quality:isAnyOf",
    expression: anyOf(SessionListField.Quality, ["idle"]),
    legacy: { quality: "idle" },
  },
  {
    covers: "projectIds:isAnyOf",
    expression: anyOf(SessionListField.ProjectIds, [PROJECT_ID]),
    legacy: { projectIds: PROJECT_ID },
  },
];

describe("lowering against the legacy params", () => {
  it("has a row for every field × operator the cloud capability declares", () => {
    const declared = Object.entries(
      CLOUD_SESSION_LIST_QUERY_CAPABILITY.fields
    ).flatMap(([field, served]) => [
      ...served.operators.map((operator) => `${field}:${operator}`),
      ...Object.entries(served.includeEmpty ?? {})
        .filter(([, values]) => values.includes(true))
        .map(([operator]) => `${field}:${operator}+includeEmpty`),
    ]);
    expect(EQUIVALENCE_ROWS.map((row) => row.covers).sort()).toEqual(
      declared.sort()
    );
  });

  it.each(EQUIVALENCE_ROWS)(
    "$covers builds the same where as its legacy params",
    async ({ expression, legacy }) => {
      const isQualityRow = expression.field === SessionListField.Quality;
      const fromLegacy = parseList(
        isQualityRow ? legacy : { quality: "all", ...legacy }
      );
      const fromExpression = parseList(
        withListQuery(
          expressionOf(isQualityRow ? [expression] : [expression, qualityAll()])
        )
      );

      expect(fromExpression).toEqual(fromLegacy);
      expect(await buildWhere(SCOPE, fromExpression, "lastActivityAt")).toEqual(
        await buildWhere(SCOPE, fromLegacy, "lastActivityAt")
      );
    }
  );

  it.each(
    AGENT_SESSION_SORT_COLUMNS.flatMap((column) =>
      Object.values(ListSortDirection).map((direction) => ({
        column,
        direction,
      }))
    )
  )(
    "sorting by $column $direction orders like sorts=$column:$direction",
    ({ column, direction }) => {
      const fromExpression = parseList(
        withListQuery(expressionOf([], [{ field: column, direction }]))
      );
      const fromLegacy = parseList({ sorts: `${column}:${direction}` });

      expect(fromExpression).toEqual(fromLegacy);
      expect(buildAgentSessionOrderBy(fromExpression)).toEqual(
        buildAgentSessionOrderBy(fromLegacy)
      );
    }
  );

  it("keeps a multi-rule sort in rule order", () => {
    const rules: ListSortRule[] = [
      { field: SessionListField.Status, direction: ListSortDirection.Asc },
      { field: SessionListField.Cost, direction: ListSortDirection.Desc },
    ];
    const fromExpression = parseList(withListQuery(expressionOf([], rules)));
    const fromLegacy = parseList({ sorts: ["status:asc", "cost:desc"] });

    expect(fromExpression).toEqual(fromLegacy);
    expect(buildAgentSessionOrderBy(fromExpression)).toEqual(
      buildAgentSessionOrderBy(fromLegacy)
    );
  });

  it.each([
    ["only a lower bound", { min: WINDOW_START }, { startDate: WINDOW_START }],
    ["only an upper bound", { max: WINDOW_END }, { endDate: WINDOW_END }],
  ])(
    "lastActivity with %s writes only that bound",
    async (_name, bounds, legacy) => {
      const fromExpression = parseList(
        withListQuery(
          expressionOf([
            {
              field: SessionListField.LastActivity,
              operator: ListFilterOperator.IsBetween,
              ...bounds,
            },
            qualityAll(),
          ])
        )
      );
      const fromLegacy = parseList({ quality: "all", ...legacy });

      expect(fromExpression).toEqual(fromLegacy);
      expect(await buildWhere(SCOPE, fromExpression, "lastActivityAt")).toEqual(
        await buildWhere(SCOPE, fromLegacy, "lastActivityAt")
      );
    }
  );

  it("naming the empty token with includeEmpty omitted selects it like the legacy id", () => {
    const fromExpression = parseList(
      withListQuery(
        expressionOf([
          anyOf(SessionListField.Autonomy, [AUTONOMY_UNKNOWN]),
          qualityAll(),
        ])
      )
    );

    expect(fromExpression).toEqual(
      parseList({ quality: "all", autonomyTiers: AUTONOMY_UNKNOWN })
    );
  });

  it("refuses a clause whose param the receiving schema does not take", () => {
    const result = lowerSessionListQueryExpression(
      expressionOf([anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE])]),
      CLOUD_SESSION_LIST_QUERY_CAPABILITY,
      { acceptedParams: new Set(["harnesses"]), repeatableParams: new Set() }
    );

    expect(result).toStrictEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.UnsupportedField,
        details: { field: SessionListField.Status },
      },
    });
  });

  it("refuses more than one value for a param the target reads as a scalar", () => {
    const result = lowerSessionListQueryExpression(
      expressionOf([anyOf(SessionListField.Harness, ["claude", "codex"])]),
      CLOUD_SESSION_LIST_QUERY_CAPABILITY,
      { acceptedParams: new Set(["harnesses"]), repeatableParams: new Set() }
    );

    expect(result).toStrictEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.TooManyValues,
        details: {
          field: SessionListField.Harness,
          operator: ListFilterOperator.IsAnyOf,
        },
      },
    });
  });

  it("refuses a built expression that repeats a field", () => {
    const result = lowerSessionListQueryExpression(
      expressionOf([
        anyOf(SessionListField.Harness, ["claude"]),
        anyOf(SessionListField.Harness, ["codex"]),
      ]),
      CLOUD_SESSION_LIST_QUERY_CAPABILITY,
      {
        acceptedParams: new Set(["harnesses"]),
        repeatableParams: new Set(["harnesses"]),
      }
    );

    expect(result).toStrictEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.Malformed,
        details: { field: SessionListField.Harness },
      },
    });
  });

  it("refuses a built isBetween clause with neither bound", () => {
    const result = lowerSessionListQueryExpression(
      expressionOf([
        {
          field: SessionListField.LastActivity,
          operator: ListFilterOperator.IsBetween,
        },
      ]),
      CLOUD_SESSION_LIST_QUERY_CAPABILITY,
      {
        acceptedParams: new Set(["startDate", "endDate"]),
        repeatableParams: new Set(),
      }
    );

    expect(result).toStrictEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.Malformed,
        details: {
          field: SessionListField.LastActivity,
          operator: ListFilterOperator.IsBetween,
        },
      },
    });
  });

  it("never hands `listQuery` on to the service", () => {
    const parsed = parseList(
      withListQuery(expressionOf([anyOf(SessionListField.Harness, ["claude"])]))
    );

    expect(Object.keys(parsed)).not.toContain(LIST_QUERY_EXPRESSION_PARAM);
  });

  it("exports the lowering for callers holding a parsed expression", () => {
    const result = lowerSessionListQueryExpression(
      expressionOf(
        [anyOf(SessionListField.Status, [SESSION_STATUS.INACTIVE])],
        [{ field: SessionListField.Started, direction: ListSortDirection.Desc }]
      ),
      CLOUD_SESSION_LIST_QUERY_CAPABILITY,
      {
        acceptedParams: new Set(["statuses", "sorts"]),
        repeatableParams: new Set(["statuses", "sorts"]),
      }
    );

    expect(result).toEqual({
      ok: true,
      params: { statuses: [SESSION_STATUS.INACTIVE], sorts: ["started:desc"] },
    });
  });
});

type RefusalCase = {
  name: string;
  params: Record<string, unknown>;
  refused: ListQueryRefused;
};

const REFUSAL_CASES: readonly RefusalCase[] = [
  {
    name: "a version this build does not read",
    params: { [LIST_QUERY_EXPRESSION_PARAM]: '{"version":2}' },
    refused: { code: ListQueryRefusal.UnsupportedVersion, details: {} },
  },
  {
    name: "a field the cloud does not have",
    params: withListQuery(expressionOf([anyOf(bogusField("nope"), ["x"])])),
    refused: {
      code: ListQueryRefusal.UnsupportedField,
      details: { field: "nope" },
    },
  },
  {
    name: "a custom field",
    params: withListQuery(
      expressionOf([anyOf(bogusField("customField:abc"), ["x"])])
    ),
    refused: {
      code: ListQueryRefusal.UnsupportedField,
      details: { field: "customField:abc" },
    },
  },
  {
    name: "a prototype key as a field",
    params: withListQuery(
      expressionOf([anyOf(bogusField("__proto__"), ["x"])])
    ),
    refused: {
      code: ListQueryRefusal.UnsupportedField,
      details: { field: "__proto__" },
    },
  },
  {
    name: "a sort on a field the cloud cannot sort by",
    params: withListQuery(
      expressionOf(
        [],
        [
          {
            field: SessionListField.ChangePresence,
            direction: ListSortDirection.Asc,
          },
        ]
      )
    ),
    refused: {
      code: ListQueryRefusal.UnsupportedField,
      details: { field: SessionListField.ChangePresence },
    },
  },
  {
    name: "an operator the field does not serve",
    params: withListQuery(
      expressionOf([
        {
          field: SessionListField.Status,
          operator: ListFilterOperator.IsBetween,
          min: "a",
        },
      ])
    ),
    refused: {
      code: ListQueryRefusal.UnsupportedOperator,
      details: {
        field: SessionListField.Status,
        operator: ListFilterOperator.IsBetween,
      },
    },
  },
  {
    name: "includeEmpty on a field with no empty token",
    params: withListQuery(
      expressionOf([
        anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE], true),
      ])
    ),
    refused: {
      code: ListQueryRefusal.UnsupportedOperator,
      details: {
        field: SessionListField.Status,
        operator: ListFilterOperator.IsEmpty,
      },
    },
  },
  {
    name: "more clauses than the wire allows",
    params: withListQuery(
      expressionOf(
        Array.from({ length: LIST_QUERY_MAX_CLAUSES + 1 }, (_, index) =>
          anyOf(bogusField(`field${index}`), ["x"])
        )
      )
    ),
    refused: { code: ListQueryRefusal.TooManyClauses, details: {} },
  },
  {
    name: "more values than a clause allows",
    params: withListQuery(
      expressionOf([
        anyOf(
          SessionListField.Repo,
          Array.from(
            {
              length:
                CLOUD_SESSION_LIST_QUERY_CAPABILITY.maxValuesPerClause + 1,
            },
            (_, index) => `org/repo-${index}`
          )
        ),
      ])
    ),
    refused: {
      code: ListQueryRefusal.TooManyValues,
      details: {
        field: SessionListField.Repo,
        operator: ListFilterOperator.IsAnyOf,
      },
    },
  },
  {
    name: "more sort rules than the wire allows",
    params: withListQuery(
      expressionOf(
        [],
        Array.from({ length: LIST_QUERY_MAX_SORT_RULES + 1 }, (_, index) => ({
          field: `sort${index}`,
          direction: ListSortDirection.Asc,
        }))
      )
    ),
    refused: { code: ListQueryRefusal.TooManySortRules, details: {} },
  },
  {
    name: "text that is not JSON",
    params: { [LIST_QUERY_EXPRESSION_PARAM]: "{not json" },
    refused: { code: ListQueryRefusal.Malformed, details: {} },
  },
  {
    name: "text past the length cap",
    params: {
      [LIST_QUERY_EXPRESSION_PARAM]: " ".repeat(
        LIST_QUERY_EXPRESSION_MAX_LENGTH + 1
      ),
    },
    refused: { code: ListQueryRefusal.Malformed, details: {} },
  },
  {
    name: "a repeated listQuery",
    params: {
      [LIST_QUERY_EXPRESSION_PARAM]: [
        JSON.stringify(expressionOf([])),
        JSON.stringify(expressionOf([])),
      ],
    },
    refused: { code: ListQueryRefusal.Malformed, details: {} },
  },
  {
    name: "the empty token named while empty rows are excluded",
    params: withListQuery(
      expressionOf([
        anyOf(SessionListField.Autonomy, [AUTONOMY_UNKNOWN], false),
      ])
    ),
    refused: {
      code: ListQueryRefusal.Malformed,
      details: {
        field: SessionListField.Autonomy,
        operator: ListFilterOperator.IsAnyOf,
      },
    },
  },
  {
    name: "a value outside a closed vocabulary",
    params: withListQuery(
      expressionOf([anyOf(SessionListField.Status, ["bogus"])])
    ),
    refused: {
      code: ListQueryRefusal.Malformed,
      details: {
        field: SessionListField.Status,
        operator: ListFilterOperator.IsAnyOf,
      },
    },
  },
  {
    name: "the expression beside a legacy facet on the same axis",
    params: {
      ...withListQuery(expressionOf([])),
      statuses: SESSION_STATUS.ACTIVE,
    },
    refused: {
      code: ListQueryRefusal.Malformed,
      details: { field: SessionListField.Status },
    },
  },
  {
    name: "the expression beside a legacy facet on another axis",
    params: {
      ...withListQuery(
        expressionOf([anyOf(SessionListField.Harness, ["claude"])])
      ),
      models: "claude-opus-5-5",
    },
    refused: {
      code: ListQueryRefusal.Malformed,
      details: { field: SessionListField.Model },
    },
  },
  {
    name: "the expression beside the legacy sort",
    params: { ...withListQuery(expressionOf([])), sortBy: "cost" },
    refused: { code: ListQueryRefusal.Malformed, details: {} },
  },
];

describe("refusals", () => {
  it.each(REFUSAL_CASES)(
    "refuses $name with its code",
    ({ params, refused }) => {
      const parsed = agentSessionListQuerySchema.safeParse(params);

      expect(parsed.success).toBe(false);
      // Strict: an absent `field` is omitted, never serialized as undefined.
      expect(
        listQueryRefusalMetadata(parsed.error?.issues ?? [])
      ).toStrictEqual(refused);
      expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([
        [LIST_QUERY_EXPRESSION_PARAM],
      ]);
    }
  );

  it.each([
    ["limit", { limit: "10" }],
    ["offset", { offset: "20" }],
    ["viewerScope", { viewerScope: AgentSessionViewerScope.Self }],
    ["teamId", { viewerScope: AgentSessionViewerScope.Team, teamId: TEAM_ID }],
    ["search", { search: "anything" }],
    ["projectId", { projectId: PROJECT_ID }],
    ["userId", { userId: USER_ID }],
  ])("lets %s travel beside the expression", (_name, companion) => {
    const parsed = agentSessionListQuerySchema.safeParse({
      ...withListQuery(
        expressionOf([anyOf(SessionListField.Harness, ["claude"])])
      ),
      ...companion,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ harnesses: ["claude"] });
  });

  it("refuses a sort on reads that take none", () => {
    const params = withListQuery(
      expressionOf(
        [],
        [{ field: SessionListField.Cost, direction: ListSortDirection.Desc }]
      )
    );

    for (const schema of [
      baseAgentSessionQuerySchema,
      agentSessionUsageQuerySchema,
      agentSessionStatusCountsQuerySchema,
    ]) {
      const parsed = schema.safeParse(params);
      expect(listQueryRefusalMetadata(parsed.error?.issues ?? [])).toEqual({
        code: ListQueryRefusal.UnsupportedField,
        details: { field: SessionListField.Cost },
      });
    }
  });
});

describe("rules the lowered values still meet", () => {
  it("status-counts refuses a status clause as an unsupported field", () => {
    const parsed = agentSessionStatusCountsQuerySchema.safeParse(
      withListQuery(
        expressionOf([anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE])])
      )
    );

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([
      [LIST_QUERY_EXPRESSION_PARAM],
    ]);
    expect(listQueryRefusalMetadata(parsed.error?.issues ?? [])).toEqual({
      code: ListQueryRefusal.UnsupportedField,
      details: { field: SessionListField.Status },
    });
  });

  it("status-counts still refuses a legacy status param with no refusal code", () => {
    const parsed = agentSessionStatusCountsQuerySchema.safeParse({
      statuses: SESSION_STATUS.ACTIVE,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([
      ["statuses"],
    ]);
    expect(listQueryRefusalMetadata(parsed.error?.issues ?? [])).toBe(
      undefined
    );
  });

  it("status-counts serves every other field through the expression", () => {
    const parsed = agentSessionStatusCountsQuerySchema.safeParse(
      withListQuery(expressionOf([anyOf(SessionListField.Harness, ["claude"])]))
    );

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ harnesses: ["claude"] });
  });

  it("team scope still needs a teamId beside an expression", () => {
    const parsed = agentSessionListQuerySchema.safeParse({
      ...withListQuery(expressionOf([])),
      viewerScope: AgentSessionViewerScope.Team,
    });

    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([
      ["teamId"],
    ]);
    expect(listQueryRefusalMetadata(parsed.error?.issues ?? [])).toBe(
      undefined
    );
  });

  it("a bare teamId beside an expression still reads as team scope", () => {
    const parsed = agentSessionListQuerySchema.safeParse({
      ...withListQuery(expressionOf([])),
      teamId: TEAM_ID,
    });

    expect(parsed.data).toMatchObject({
      viewerScope: AgentSessionViewerScope.Team,
      teamId: TEAM_ID,
    });
  });

  it("limit keeps its ceiling beside an expression", () => {
    const parsed = agentSessionListQuerySchema.safeParse({
      ...withListQuery(expressionOf([])),
      limit: String(SESSION_LIST_MAX_LIMIT + 1),
    });

    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([
      ["limit"],
    ]);
    expect(listQueryRefusalMetadata(parsed.error?.issues ?? [])).toBe(
      undefined
    );
  });

  it("a request with no expression parses exactly as before", () => {
    const legacy = { statuses: SESSION_STATUS.ACTIVE, sortBy: "cost" };

    expect(agentSessionListQuerySchema.parse(legacy)).toEqual({
      statuses: [SESSION_STATUS.ACTIVE],
      sortBy: "cost",
    });
  });
});

function parseList(params: Record<string, unknown>) {
  return agentSessionListQuerySchema.parse(params);
}

function withListQuery(expression: ListQueryExpression): RawParams {
  return { [LIST_QUERY_EXPRESSION_PARAM]: JSON.stringify(expression) };
}

function expressionOf(
  filters: ListFilterClause[],
  sorts: ListSortRule[] = []
): ListQueryExpression {
  return { version: LIST_QUERY_EXPRESSION_VERSION, filters, sorts };
}

function qualityAll(): ListFilterClause {
  return anyOf(SessionListField.Quality, ["all"]);
}

/** A field id outside `SessionListField`, which is the point of the case. */
function bogusField(field: string): SessionListField {
  return field as SessionListField;
}

function requireDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}
