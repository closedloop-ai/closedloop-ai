/**
 * ISS-9476 — the Sessions field registry in `@repo/api` against the schema it
 * describes. `packages/api` cannot import `apps/api`, so the registry writes
 * the param names and sort columns out, and this file is where they are held
 * equal to `AgentSessionListQuery` and `AGENT_SESSION_SORT_COLUMNS`.
 *
 * The two literal `Record`s below are the compile-time half: a new sort column
 * or a new list param fails `tsc` for this file until the registry, or the
 * non-field list, accounts for it. The runtime half checks the registry itself
 * claims what these Records say.
 */
import { resolveListQueryCapability } from "@repo/api/src/types/list-query-capability";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  type ListFilterScalar,
  listFieldLegacyParams,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { CLOUD_SESSION_LIST_QUERY_CAPABILITY } from "@repo/api/src/types/session-list-query-capabilities";
import {
  SESSION_LIST_NON_FIELD_PARAMS,
  SESSION_LIST_QUERY_FIELDS,
  type SessionListLegacyFilterParam,
  type SessionListNonFieldParam,
} from "@repo/api/src/types/session-list-query-registry";
import { describe, expect, it } from "vitest";
import {
  AGENT_SESSION_LIST_QUERY_PARAM_NAMES,
  AGENT_SESSION_SORT_COLUMNS,
  type AgentSessionListQuery,
  type AgentSessionSortColumn,
  agentSessionListQuerySchema,
} from "../validators";

type AgentSessionListParam = keyof AgentSessionListQuery;
type AgentSessionFilterParam = Exclude<
  AgentSessionListParam,
  SessionListNonFieldParam
>;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Every non-field param is a real list param, and the registry's legacy param
// union is exactly the rest of them.
const nonFieldParamsExist: Equal<
  Extract<SessionListNonFieldParam, AgentSessionListParam>,
  SessionListNonFieldParam
> = true;
const legacyParamsAreTheRest: Equal<
  SessionListLegacyFilterParam,
  AgentSessionFilterParam
> = true;

const FIELD_BY_SORT_COLUMN = {
  user: SessionListField.User,
  status: SessionListField.Status,
  repo: SessionListField.Repo,
  harness: SessionListField.Harness,
  model: SessionListField.Model,
  autonomy: SessionListField.Autonomy,
  duration: SessionListField.Duration,
  cost: SessionListField.Cost,
  started: SessionListField.Started,
  priority: SessionListField.Priority,
  updated: SessionListField.Updated,
  lastActivity: SessionListField.LastActivity,
  assignee: SessionListField.Assignee,
} satisfies Record<AgentSessionSortColumn, SessionListField>;

const FIELD_BY_FILTER_PARAM = {
  statuses: SessionListField.Status,
  status: SessionListField.Status,
  userIds: SessionListField.User,
  repositories: SessionListField.Repo,
  harnesses: SessionListField.Harness,
  harness: SessionListField.Harness,
  models: SessionListField.Model,
  autonomyTiers: SessionListField.Autonomy,
  costBuckets: SessionListField.Cost,
  changePresence: SessionListField.ChangePresence,
  prAssociation: SessionListField.PrAssociation,
  priorities: SessionListField.Priority,
  quality: SessionListField.Quality,
  projectIds: SessionListField.ProjectIds,
  startDate: SessionListField.LastActivity,
  endDate: SessionListField.LastActivity,
} satisfies Record<AgentSessionFilterParam, SessionListField>;

function registryClaims(): Record<string, string> {
  const claims: Record<string, string> = {};
  for (const [field, spec] of Object.entries(SESSION_LIST_QUERY_FIELDS)) {
    for (const param of listFieldLegacyParams(spec)) {
      claims[param] = field;
    }
  }
  return claims;
}

describe("Sessions list query field registry", () => {
  it("holds its param lists equal to the list schema at compile time", () => {
    expect([nonFieldParamsExist, legacyParamsAreTheRest]).toEqual([true, true]);
  });

  it("names each sort column as its own field id", () => {
    for (const [column, field] of Object.entries(FIELD_BY_SORT_COLUMN)) {
      expect(field).toBe(column);
    }
  });

  it("claims every list filter param with the field that owns it", () => {
    expect(registryClaims()).toEqual(FIELD_BY_FILTER_PARAM);
  });

  it("accounts for every param the list route accepts", () => {
    expect(
      [
        ...Object.keys(registryClaims()),
        ...Object.keys(SESSION_LIST_NON_FIELD_PARAMS),
      ].sort()
    ).toEqual(
      // ISS-9477: the expression's own carrier is neither a field's legacy
      // param nor a non-field legacy param — it is the expression.
      AGENT_SESSION_LIST_QUERY_PARAM_NAMES.filter(
        (name) => name !== LIST_QUERY_EXPRESSION_PARAM
      ).sort()
    );
  });

  it("gives a sort rank to exactly the sort columns", () => {
    const ranked = Object.entries(SESSION_LIST_QUERY_FIELDS)
      .filter(([, spec]) => spec.sortRank !== null)
      .map(([field]) => field);
    expect(ranked.sort()).toEqual([...AGENT_SESSION_SORT_COLUMNS].sort());
  });

  it("declares the cloud host sortable on exactly the sort columns", () => {
    const sortable = Object.entries(CLOUD_SESSION_LIST_QUERY_CAPABILITY.fields)
      .filter(([, served]) => served.sortable)
      .map(([field]) => field);
    expect(sortable.sort()).toEqual([...AGENT_SESSION_SORT_COLUMNS].sort());
  });
});

/** Includes the nil and max UUIDs and one of each wrong version/variant nibble. */
const UUID_SAMPLES = [
  "01a07463-31f5-773e-9fa9-bd1dbdac9f1b",
  "0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "01a07463-31f5-073e-9fa9-bd1dbdac9f1b",
  "01a07463-31f5-973e-9fa9-bd1dbdac9f1b",
  "01a07463-31f5-773e-cfa9-bd1dbdac9f1b",
  "01a0746331f5773e9fa9bd1dbdac9f1b",
  "not-a-uuid",
] as const;

/** Parsable and unparsable, plus the Postgres floor and the instant below it. */
const TIMESTAMP_SAMPLES = [
  "2026-09-24",
  "2026-09-24T10:00:00.000Z",
  "Thu, 24 Sep 2026 10:00:00 GMT",
  "2026-13-40",
  "yesterday",
  " ",
  "-004712-01-01T00:00:00.000Z",
  "-004713-12-31T23:59:59.999Z",
] as const;

/** Text the free-text facets read, padded text, blanks, and a number. */
const TEXT_SAMPLES = [
  "closedloop-ai/closedloop-ai",
  " padded ",
  "   ",
  "",
  7,
] as const;

function cloudServes(
  field: SessionListField,
  operator: ListFilterOperator,
  value: ListFilterScalar
): boolean {
  const clause =
    operator === ListFilterOperator.IsAnyOf
      ? { field, operator, values: [value] }
      : { field, operator: ListFilterOperator.IsBetween, min: value };
  return resolveListQueryCapability(
    { version: LIST_QUERY_EXPRESSION_VERSION, filters: [clause] },
    CLOUD_SESSION_LIST_QUERY_CAPABILITY
  ).ok;
}

describe("cloud Sessions value formats against the list route schema", () => {
  it.each([
    [SessionListField.User, "userIds"],
    [SessionListField.ProjectIds, "projectIds"],
  ] as const)("serves exactly the %s values %s accepts", (field, param) => {
    for (const value of UUID_SAMPLES) {
      expect(cloudServes(field, ListFilterOperator.IsAnyOf, value), value).toBe(
        agentSessionListQuerySchema.safeParse({ [param]: value }).success
      );
    }
  });

  it.each([
    [SessionListField.Repo, "repositories"],
    [SessionListField.Harness, "harnesses"],
    [SessionListField.Model, "models"],
  ] as const)("serves exactly the %s values %s accepts", (field, param) => {
    for (const value of TEXT_SAMPLES) {
      expect(
        cloudServes(field, ListFilterOperator.IsAnyOf, value),
        String(value)
      ).toBe(agentSessionListQuerySchema.safeParse({ [param]: value }).success);
    }
  });

  it("serves exactly the lastActivity bounds startDate accepts", () => {
    for (const value of TIMESTAMP_SAMPLES) {
      expect(
        cloudServes(
          SessionListField.LastActivity,
          ListFilterOperator.IsBetween,
          value
        ),
        value
      ).toBe(
        agentSessionListQuerySchema.safeParse({ startDate: value }).success
      );
    }
  });
});
