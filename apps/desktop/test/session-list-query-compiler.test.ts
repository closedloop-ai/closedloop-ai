/**
 * ISS-9479 — the desktop `listQuery` compiler at the Sessions IPC request
 * boundary. Driven through `coerceSharedAgentSessionsListRequest`, the
 * coercion every Sessions read channel runs, so each case is the request main
 * actually hands the read.
 */
import {
  SESSION_UNKNOWN_COST_BUCKET_ID,
  SessionChangePresenceId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import type { AutonomyTier } from "@repo/api/src/session-autonomy-tiers";
import { buildSessionListQueryIpcRequest } from "@repo/api/src/types/list-query-client-requests";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  LIST_QUERY_MAX_CLAUSES,
  LIST_QUERY_MAX_VALUES_PER_CLAUSE,
  type ListFilterClause,
  ListFilterOperator,
  type ListQueryExpression,
  ListQueryRefusal,
  type ListQueryRefused,
  ListSortDirection,
  type ListSortRule,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import {
  PRIORITY_UNSET_VALUE,
  PRIORITY_VALUES,
} from "@repo/api/src/types/search-query";
import { SESSION_LIST_QUERY_FIELDS } from "@repo/api/src/types/session-list-query-registry";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  coerceSharedAgentSessionsListRequest,
  coerceSharedAgentSessionsQuery,
} from "../src/main/dashboard/agent-dashboard-ipc-coercion.js";
import {
  compileSessionListQueryRequest,
  SessionListQueryRefusedError,
} from "../src/main/session/session-list-query-compiler.js";
import {
  SharedAgentSessionsInputError,
  sanitizeQuery,
} from "../src/main/session/shared-agent-sessions-query.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/shared/session-date-window-contract.js";
import { sharedAgentSessionsListRequestSchema } from "../src/shared/shared-agent-sessions-contract-schema.js";

const OWNER_A = "user-a";
const OWNER_B = "user-b";
const WINDOW_START = "2026-09-01T00:00:00.000Z";
const WINDOW_END = "2026-09-30T23:59:59.999Z";
const HIGH_AUTONOMY = "high" satisfies AutonomyTier;
const AUTONOMY_EMPTY_TOKEN =
  SESSION_LIST_QUERY_FIELDS[SessionListField.Autonomy].anyOf?.emptyToken;
const EMPTY_EXPRESSION: ListQueryExpression = {
  version: LIST_QUERY_EXPRESSION_VERSION,
};
const LAST_ACTIVITY_DESC: ListSortRule = {
  field: SessionListField.LastActivity,
  direction: ListSortDirection.Desc,
};
const BLANK_DROPPING_FIELDS = [
  SessionListField.User,
  SessionListField.Repo,
  SessionListField.Harness,
  SessionListField.Model,
];

describe("renderer listQuery round trip (ISS-12938)", () => {
  // The Sessions grid builds its IPC read with buildSessionListQueryIpcRequest
  // (local-agent-sessions-data-source.ts); main compiles it back. Every filter,
  // the sort and the search must survive, or the list stops filtering.
  it("hands main every filter, the sort and the search the renderer chose", () => {
    const legacy = {
      readInitiator: ReadInitiator.User,
      limit: 25,
      offset: 0,
      search: "Failed Session",
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      statuses: [SESSION_STATUS.ACTIVE],
      repositories: ["closedloop-ai/closedloop-ai"],
      harnesses: ["claude-code"],
      models: ["claude-opus-4"],
      autonomyTiers: [HIGH_AUTONOMY],
      costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID],
      changePresence: [SessionChangePresenceId.HasChanges],
      prAssociation: [SessionPrAssociationId.HasPr],
      userIds: [OWNER_A],
      sortBy: SessionListField.LastActivity,
      sortDir: ListSortDirection.Desc,
    };
    const sent = buildSessionListQueryIpcRequest(legacy);

    expect(sent).not.toBeNull();
    expect(sent).toMatchObject({ search: "Failed Session" });
    // Pinned first: a request that failed to parse would coerce to {} on both
    // sides and make the equality below vacuous.
    expect(readQuery(legacy)).toMatchObject({
      search: "Failed Session",
      statuses: [SESSION_STATUS.ACTIVE],
      userIds: [OWNER_A],
      sortBy: SessionListField.LastActivity,
    });
    // Main lowers the sort to `sorts`, which the read resolves exactly as the
    // legacy `sortBy`/`sortDir` pair, so the comparison is of what is read.
    expect(readQuery(sent)).toEqual(readQuery(legacy));
  });
});

describe("compileSessionListQueryRequest (ISS-9479)", () => {
  it("hands back a request with no expression untouched", () => {
    const legacy = { statuses: [SESSION_STATUS.ACTIVE], limit: 25 };

    expect(compileSessionListQueryRequest(legacy)).toBe(legacy);
    expect(coerceSharedAgentSessionsListRequest(legacy)).toEqual(
      sharedAgentSessionsListRequestSchema.parse(legacy)
    );
  });

  it("lowers each served clause to the legacy param the read serves", () => {
    const compiled = coerceSharedAgentSessionsListRequest(
      requestOf(
        [
          anyOf(SessionListField.User, [OWNER_A, OWNER_B]),
          anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE]),
          anyOf(SessionListField.Repo, ["org/repo"]),
          anyOf(SessionListField.Harness, ["claude"]),
          anyOf(SessionListField.Model, ["opus"]),
          anyOf(SessionListField.ChangePresence, [
            SessionChangePresenceId.HasChanges,
          ]),
          anyOf(SessionListField.PrAssociation, [SessionPrAssociationId.NoPr]),
          anyOf(SessionListField.Quality, ["substantive"]),
          {
            field: SessionListField.LastActivity,
            operator: ListFilterOperator.IsBetween,
            min: WINDOW_START,
            max: WINDOW_END,
          },
        ],
        [LAST_ACTIVITY_DESC]
      )
    );

    expect(compiled).toEqual({
      userIds: [OWNER_A, OWNER_B],
      statuses: [SESSION_STATUS.ACTIVE],
      repositories: ["org/repo"],
      harnesses: ["claude"],
      models: ["opus"],
      changePresence: [SessionChangePresenceId.HasChanges],
      prAssociation: [SessionPrAssociationId.NoPr],
      quality: "substantive",
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      sorts: ["lastActivity:desc"],
    });
  });

  it("lowers includeEmpty and the emptiness operators through the registry's tokens", () => {
    const compiled = coerceSharedAgentSessionsListRequest(
      requestOf([
        {
          ...anyOf(SessionListField.Autonomy, [HIGH_AUTONOMY]),
          includeEmpty: true,
        },
        { field: SessionListField.Cost, operator: ListFilterOperator.IsEmpty },
        {
          field: SessionListField.Priority,
          operator: ListFilterOperator.IsNotEmpty,
        },
      ])
    );

    expect(compiled).toEqual({
      autonomyTiers: [HIGH_AUTONOMY, AUTONOMY_EMPTY_TOKEN],
      costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID],
      priorities: [...PRIORITY_VALUES],
    });
  });

  it("keeps paging, scope, search and desktop read hints beside the expression", () => {
    const compiled = coerceSharedAgentSessionsListRequest({
      ...requestOf([anyOf(SessionListField.User, [OWNER_A])]),
      limit: 25,
      offset: 50,
      search: "parser",
      userId: OWNER_A,
      teamId: "team-1",
      projectId: "project-1",
      countOnly: true,
      ids: ["session-1"],
      // Undefined is absent: a renderer spreading its filters sends these.
      statuses: undefined,
      sortBy: undefined,
    });

    expect(compiled).toEqual({
      userIds: [OWNER_A],
      limit: 25,
      offset: 50,
      search: "parser",
      userId: OWNER_A,
      teamId: "team-1",
      projectId: "project-1",
      countOnly: true,
      ids: ["session-1"],
      statuses: undefined,
      sortBy: undefined,
    });
  });

  it.each<[string, Record<string, unknown>, ListQueryRefused]>([
    [
      "a newer client's expression version",
      { [LIST_QUERY_EXPRESSION_PARAM]: { version: 2 } },
      refused(ListQueryRefusal.UnsupportedVersion),
    ],
    [
      "an operator this build has never seen",
      requestOf([
        { field: SessionListField.Repo, operator: "contains", values: ["x"] },
      ]),
      refused(ListQueryRefusal.UnsupportedOperator, {
        field: SessionListField.Repo,
        operator: "contains",
      }),
    ],
    [
      "the cloud-only project facet",
      requestOf([anyOf(SessionListField.ProjectIds, ["project-1"])]),
      refused(ListQueryRefusal.UnsupportedField, {
        field: SessionListField.ProjectIds,
      }),
    ],
    [
      "a scope axis written as a field",
      requestOf([anyOf("teamId", ["team-1"])]),
      refused(ListQueryRefusal.UnsupportedField, { field: "teamId" }),
    ],
    [
      "a sort the local read cannot order by",
      requestOf(
        [],
        [{ field: SessionListField.Autonomy, direction: ListSortDirection.Asc }]
      ),
      refused(ListQueryRefusal.UnsupportedField, {
        field: SessionListField.Autonomy,
      }),
    ],
    [
      "a second sort rule",
      requestOf(
        [],
        [
          LAST_ACTIVITY_DESC,
          { field: SessionListField.Started, direction: ListSortDirection.Asc },
        ]
      ),
      refused(ListQueryRefusal.TooManySortRules),
    ],
    [
      "more clauses than the wire carries",
      requestOf(
        Array.from({ length: LIST_QUERY_MAX_CLAUSES + 1 }, (_, index) =>
          anyOf(`field-${index}`, ["x"])
        )
      ),
      refused(ListQueryRefusal.TooManyClauses),
    ],
    [
      "more values than a clause carries",
      requestOf([
        anyOf(
          SessionListField.Repo,
          Array.from(
            { length: LIST_QUERY_MAX_VALUES_PER_CLAUSE + 1 },
            (_, index) => `org/repo-${index}`
          )
        ),
      ]),
      refused(ListQueryRefusal.TooManyValues, {
        field: SessionListField.Repo,
        operator: ListFilterOperator.IsAnyOf,
      }),
    ],
    [
      "two values for the single-value quality segment",
      requestOf([anyOf(SessionListField.Quality, ["idle", "all"])]),
      refused(ListQueryRefusal.TooManyValues, {
        field: SessionListField.Quality,
        operator: ListFilterOperator.IsAnyOf,
      }),
    ],
    [
      "a status outside the closed vocabulary",
      requestOf([anyOf(SessionListField.Status, ["waiting"])]),
      refused(ListQueryRefusal.Malformed, {
        field: SessionListField.Status,
        operator: ListFilterOperator.IsAnyOf,
      }),
    ],
    [
      "the no-value token while excluding empty rows",
      requestOf([
        {
          ...anyOf(SessionListField.Priority, [PRIORITY_UNSET_VALUE]),
          includeEmpty: false,
        },
      ]),
      refused(ListQueryRefusal.Malformed, {
        field: SessionListField.Priority,
        operator: ListFilterOperator.IsAnyOf,
      }),
    ],
    ...BLANK_DROPPING_FIELDS.map(
      (field): [string, Record<string, unknown>, ListQueryRefused] => [
        `a blank ${field} value, which the read drops and widens on`,
        requestOf([anyOf(field, [" "])]),
        refused(ListQueryRefusal.Malformed, {
          field,
          operator: ListFilterOperator.IsAnyOf,
        }),
      ]
    ),
    [
      "an expression sent as its URL text",
      { [LIST_QUERY_EXPRESSION_PARAM]: JSON.stringify(expressionOf([])) },
      refused(ListQueryRefusal.Malformed),
    ],
    [
      "a legacy facet beside the expression",
      {
        ...requestOf([anyOf(SessionListField.Repo, ["org/repo"])]),
        statuses: [SESSION_STATUS.ACTIVE],
      },
      refused(ListQueryRefusal.Malformed, { field: SessionListField.Status }),
    ],
    [
      "a legacy alias beside the expression",
      { ...requestOf([]), harness: "claude" },
      refused(ListQueryRefusal.Malformed, { field: SessionListField.Harness }),
    ],
    [
      "a legacy sort beside the expression",
      { ...requestOf([]), sortBy: SessionListField.Started },
      refused(ListQueryRefusal.Malformed),
    ],
    [
      "the unmodeled completion bound beside the expression",
      { ...requestOf([]), completedAfter: WINDOW_START },
      refused(ListQueryRefusal.Malformed),
    ],
  ])("refuses %s", (_name, request, expected) => {
    expect(
      refusalOf(() => coerceSharedAgentSessionsListRequest(request))
    ).toEqual(expected);
  });

  it("refuses on the usage channel's coercion too, never answering unfiltered", () => {
    expect(
      refusalOf(() =>
        coerceSharedAgentSessionsQuery(
          requestOf([anyOf(SessionListField.ProjectIds, ["project-1"])])
        )
      )
    ).toEqual(
      refused(ListQueryRefusal.UnsupportedField, {
        field: SessionListField.ProjectIds,
      })
    );
  });

  it("refuses an expression that reaches a read without being lowered", () => {
    expect(() =>
      sanitizeQuery(
        { [LIST_QUERY_EXPRESSION_PARAM]: EMPTY_EXPRESSION },
        SESSIONS_SURFACE_DATE_WINDOW_FIELD
      )
    ).toThrow(SharedAgentSessionsInputError);
  });
});

function anyOf(field: string, values: string[]): ListFilterClause {
  return { field, operator: ListFilterOperator.IsAnyOf, values };
}

/** Untyped, as the IPC payload is: the table sends shapes the type refuses. */
function expressionOf(
  filters: unknown[],
  sorts: ListSortRule[] = []
): Record<string, unknown> {
  return { version: LIST_QUERY_EXPRESSION_VERSION, filters, sorts };
}

function requestOf(
  filters: unknown[],
  sorts: ListSortRule[] = []
): Record<string, unknown> {
  return { [LIST_QUERY_EXPRESSION_PARAM]: expressionOf(filters, sorts) };
}

function refused(
  code: ListQueryRefusal,
  details: ListQueryRefused["details"] = {}
): ListQueryRefused {
  return { code, details };
}

function refusalOf(compile: () => unknown): ListQueryRefused | null {
  try {
    compile();
    return null;
  } catch (error) {
    if (error instanceof SessionListQueryRefusedError) {
      return error.refused;
    }
    throw error;
  }
}

/** What the local read runs for one renderer request, after IPC coercion. */
function readQuery(request: unknown) {
  return sanitizeQuery(
    coerceSharedAgentSessionsListRequest(request),
    SESSIONS_SURFACE_DATE_WINDOW_FIELD
  );
}
