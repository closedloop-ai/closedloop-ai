/**
 * ISS-9483 (PRD-721 R10-S08) — version-skewed and unknown Sessions list
 * requests, run by both halves of the parity harness.
 *
 * Two lists:
 *   - {@link SESSION_LIST_PARITY_REFUSALS}: an expression neither host can
 *     read — a newer version, an unknown key, field or operator, a value
 *     outside a closed set. Each host refuses it with the same ISS-9476 code,
 *     never by dropping the part it cannot read.
 *   - {@link SESSION_LIST_PARITY_LEGACY_REQUESTS}: requests without
 *     `listQuery`, in the params older clients and saved links send, read
 *     against the conform scenario's rows (`session-list-parity-conform.ts`).
 *     Both hosts return the same keys. Retired status spellings
 *     (`RETIRED_DISPLAY_FACET_SPELLINGS`, ISS-10364) are among them.
 *
 * Pure data: no test runner, no database, no Electron.
 */
import {
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  ListQueryRefusal,
  ListSortDirection,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  RETIRED_DISPLAY_FACET_SPELLINGS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";

export type SessionListParityRefusalRequest = {
  name: string;
  /** The `listQuery` value as it arrives: JSON text on the cloud, an object over IPC. */
  listQuery: Record<string, unknown>;
  refusal: ListQueryRefusal;
};

/** A field id neither Sessions host declares. */
const UNDECLARED_FIELD = "mood";
const [RETIRED_STATUS] = RETIRED_DISPLAY_FACET_SPELLINGS;

export const SESSION_LIST_PARITY_REFUSALS: readonly SessionListParityRefusalRequest[] =
  [
    {
      name: "a newer expression version",
      listQuery: { version: LIST_QUERY_EXPRESSION_VERSION + 1 },
      refusal: ListQueryRefusal.UnsupportedVersion,
    },
    {
      name: "an unknown key beside the version",
      listQuery: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        [UNDECLARED_FIELD]: true,
      },
      refusal: ListQueryRefusal.Malformed,
    },
    {
      name: "a filter on a field neither host declares",
      listQuery: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: UNDECLARED_FIELD,
            operator: ListFilterOperator.IsAnyOf,
            values: ["calm"],
          },
        ],
      },
      refusal: ListQueryRefusal.UnsupportedField,
    },
    {
      name: "a sort on a field neither host declares",
      listQuery: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        sorts: [{ field: UNDECLARED_FIELD, direction: ListSortDirection.Asc }],
      },
      refusal: ListQueryRefusal.UnsupportedField,
    },
    {
      name: "an operator the status field does not take",
      listQuery: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: SessionListField.Status,
            operator: ListFilterOperator.IsBetween,
            min: SESSION_STATUS.ACTIVE,
            max: SESSION_STATUS.INACTIVE,
          },
        ],
      },
      refusal: ListQueryRefusal.UnsupportedOperator,
    },
    {
      name: "a retired status spelling",
      listQuery: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: SessionListField.Status,
            operator: ListFilterOperator.IsAnyOf,
            values: [RETIRED_STATUS],
          },
        ],
      },
      refusal: ListQueryRefusal.Malformed,
    },
    {
      name: "a priority outside its closed set",
      listQuery: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: SessionListField.Priority,
            operator: ListFilterOperator.IsAnyOf,
            values: ["p9"],
          },
        ],
      },
      refusal: ListQueryRefusal.Malformed,
    },
  ];

/** Legacy params as a client sends them: a repeated param is an array. */
export type SessionListParityLegacyParams = Readonly<
  Record<string, string | readonly string[]>
>;

export type SessionListParityLegacyRequest = {
  name: string;
  params: SessionListParityLegacyParams;
  expectedKeys: readonly string[];
};

const BY_LAST_ACTIVITY = {
  sortBy: SessionListField.LastActivity,
  sortDir: ListSortDirection.Desc,
} as const;

export const SESSION_LIST_PARITY_LEGACY_REQUESTS: readonly SessionListParityLegacyRequest[] =
  [
    {
      name: "a scalar sortBy and sortDir",
      params: {
        sortBy: SessionListField.Cost,
        sortDir: ListSortDirection.Desc,
      },
      expectedKeys: ["p05", "p03", "p07", "p01", "p06", "p08", "p02", "p04"],
    },
    {
      name: "statuses, two values",
      params: {
        ...BY_LAST_ACTIVITY,
        statuses: [SESSION_STATUS.INACTIVE, SESSION_STATUS.ERROR],
      },
      expectedKeys: ["p06", "p04", "p02", "p05", "p08"],
    },
    {
      name: "a retired status spelling beside a current one",
      params: {
        ...BY_LAST_ACTIVITY,
        statuses: [SESSION_STATUS.ACTIVE, RETIRED_STATUS],
      },
      expectedKeys: ["p07", "p01", "p03"],
    },
    {
      name: "a retired status spelling alone",
      params: { ...BY_LAST_ACTIVITY, statuses: [RETIRED_STATUS] },
      expectedKeys: [],
    },
  ];
