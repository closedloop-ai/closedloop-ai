/**
 * ISS-12271 — a scoped `userId` beside `listQuery`, run by both halves of the
 * Sessions list parity harness against the conform scenario's rows
 * (`session-list-parity-conform.ts`). Each host sends `userId`
 * alone, `listQuery` alone, and both, and must return the intersection for the
 * pair (Perrin Upcott, 2026-10-08: "Align cloud to intersect"). Two owners, so
 * the pair answers a strict subset of each half. A User clause beside the
 * scope can only narrow it (FEA-4304, the 2026-09-24 ISS-9479 thread).
 *
 * Pure data: no test runner, no database, no Electron.
 */
import {
  LIST_QUERY_EXPRESSION_VERSION,
  type ListQueryExpression,
  ListSortDirection,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  anyOf,
  desc,
  SessionListParityOwner,
} from "./session-list-parity-model";

const A = SessionListParityOwner.A;
const B = SessionListParityOwner.B;

export type SessionListParityScopedUserRequest = {
  name: string;
  /** Sent as `userId`, bound to the host's id for this owner. */
  userId?: SessionListParityOwner;
  /**
   * Sent as `listQuery`, its User clause bound like `userId`. Absent, the
   * request is the legacy one an older client sends, ordered by
   * {@link SESSION_LIST_PARITY_SCOPED_USER_LEGACY_SORT}.
   */
  expression?: ListQueryExpression;
  expectedKeys: readonly string[];
};

/**
 * The legacy spelling of the expressions' sort. Both hosts order an unsorted
 * read differently (`SessionListLegacyParamBehavior.unsortedOrder`), so the
 * request without `listQuery` states its order too.
 */
export const SESSION_LIST_PARITY_SCOPED_USER_LEGACY_SORT = {
  sortBy: SessionListField.LastActivity,
  sortDir: ListSortDirection.Desc,
} as const;

const ACTIVE_STATUS = lastActivityExpression([
  anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE]),
]);

export const SESSION_LIST_PARITY_SCOPED_USER_REQUESTS: readonly SessionListParityScopedUserRequest[] =
  [
    {
      name: "userId alone",
      userId: B,
      expectedKeys: ["p03", "p06", "p04", "p08"],
    },
    {
      name: "listQuery alone",
      expression: ACTIVE_STATUS,
      expectedKeys: ["p07", "p01", "p03"],
    },
    {
      name: "userId and listQuery together",
      userId: B,
      expression: ACTIVE_STATUS,
      expectedKeys: ["p03"],
    },
    {
      name: "a User clause naming both owners beside userId",
      userId: A,
      expression: lastActivityExpression([
        anyOf(SessionListField.User, [A, B]),
      ]),
      expectedKeys: ["p07", "p01", "p02", "p05"],
    },
    {
      name: "a User clause excluding the userId owner",
      userId: A,
      expression: lastActivityExpression([anyOf(SessionListField.User, [B])]),
      expectedKeys: [],
    },
  ];

function lastActivityExpression(
  filters: NonNullable<ListQueryExpression["filters"]>
): ListQueryExpression {
  return {
    version: LIST_QUERY_EXPRESSION_VERSION,
    filters,
    sorts: [desc(SessionListField.LastActivity)],
  };
}
