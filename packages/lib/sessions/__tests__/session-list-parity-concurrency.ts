/**
 * ISS-9483 (PRD-721 R10-S08) — a write landing between two reads of the
 * Sessions list, run by both halves of the parity harness.
 *
 * Each host seeds {@link SESSION_LIST_PARITY_CONCURRENT_UPDATE}'s rows into a
 * store of its own, reads the `before` cases, applies the writes through its
 * own store, then reads the `after` cases. Offset paging is not insert-stable
 * by design (ISS-9478's ruling, `session-sort-total-order.test.ts`): a page
 * read after a write answers for the population AS WRITTEN, so both hosts must
 * agree on that answer, and neither may serve the rows or count it read before
 * the write.
 *
 * Pure data: no test runner, no database, no Electron.
 */
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import {
  anyOf,
  type ConformCase,
  conform,
  desc,
  row,
  type SessionListParityRow,
} from "./session-list-parity-model";

/**
 * One row's write. `lastActivityAt` arrives as a new activity record (a
 * desktop event; the cloud's column), `status` and `endedAt` as the row's own
 * columns. `updatedAt` is the write's instant on both hosts.
 */
export type SessionListParityWrite = {
  key: string;
  updatedAt: string;
  lastActivityAt?: string;
  status?: SessionStatus;
  endedAt?: string | null;
};

export type SessionListParityConcurrentUpdate = {
  name: string;
  rows: readonly SessionListParityRow[];
  before: readonly ConformCase[];
  writes: readonly SessionListParityWrite[];
  after: readonly ConformCase[];
};

const byLastActivity = [desc(SessionListField.LastActivity)];

const ROWS: readonly SessionListParityRow[] = [
  row({
    key: "u1",
    status: SESSION_STATUS.ACTIVE,
    startedAt: "2026-06-10T01:00:00.000Z",
    lastActivityAt: "2026-06-12T04:00:00.000Z",
    updatedAt: "2026-06-12T04:00:00.000Z",
  }),
  row({
    key: "u2",
    status: SESSION_STATUS.ACTIVE,
    startedAt: "2026-06-10T02:00:00.000Z",
    lastActivityAt: "2026-06-12T03:00:00.000Z",
    updatedAt: "2026-06-12T03:00:00.000Z",
  }),
  row({
    key: "u3",
    status: SESSION_STATUS.ACTIVE,
    startedAt: "2026-06-10T03:00:00.000Z",
    lastActivityAt: "2026-06-12T02:00:00.000Z",
    updatedAt: "2026-06-12T02:00:00.000Z",
  }),
  row({
    key: "u4",
    status: SESSION_STATUS.ACTIVE,
    startedAt: "2026-06-10T04:00:00.000Z",
    lastActivityAt: "2026-06-12T01:00:00.000Z",
    updatedAt: "2026-06-12T01:00:00.000Z",
  }),
];

const WRITE_INSTANT = "2026-06-12T05:00:00.000Z";

export const SESSION_LIST_PARITY_CONCURRENT_UPDATE: SessionListParityConcurrentUpdate =
  {
    name: "a write between two page reads",
    rows: ROWS,
    before: [
      {
        ...conform("first page", [], byLastActivity, ["u1", "u2"]),
        page: { limit: 2, offset: 0 },
        expectedTotal: ROWS.length,
      },
      conform(
        "active rows",
        [anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE])],
        byLastActivity,
        ["u1", "u2", "u3", "u4"]
      ),
    ],
    // u4 gets new activity and moves to the top; u2 ends.
    writes: [
      { key: "u4", updatedAt: WRITE_INSTANT, lastActivityAt: WRITE_INSTANT },
      {
        key: "u2",
        updatedAt: WRITE_INSTANT,
        status: SESSION_STATUS.INACTIVE,
        endedAt: "2026-06-12T03:00:00.000Z",
      },
    ],
    after: [
      {
        ...conform("second page", [], byLastActivity, ["u2", "u3"]),
        page: { limit: 2, offset: 2 },
        expectedTotal: ROWS.length,
      },
      conform(
        "active rows",
        [anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE])],
        byLastActivity,
        ["u4", "u1", "u3"]
      ),
      conform(
        "inactive rows",
        [anyOf(SessionListField.Status, [SESSION_STATUS.INACTIVE])],
        byLastActivity,
        ["u2"]
      ),
    ],
  };
