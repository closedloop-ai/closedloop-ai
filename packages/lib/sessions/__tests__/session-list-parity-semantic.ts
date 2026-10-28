/**
 * ISS-9483 (PRD-721 R10-S08) — the Sessions list parity scenario for compound
 * filters and the status and priority sorts.
 *
 * Five sessions with one each of the three statuses among the first three and
 * one each of the four priorities plus an unset one, so a status or priority
 * sort over them never leans on the id tie-break. Status sorts by its stored
 * value; priority by `PRIORITY_ORDINAL` (`SESSION_LIST_QUERY_FIELDS`).
 * Inactive and errored rows end at their last activity, so the desktop's
 * ended-row reconciliation never fires.
 */
import type { SessionCostBucketId } from "@repo/api/src/agent-session-filters";
import { Priority } from "@repo/api/src/types/common";
import { ListFilterOperator } from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Harness } from "../../harness/types";
import {
  anyOf,
  asc,
  between,
  conform,
  desc,
  emptiness,
  row,
  SessionListParityOwner,
  type SessionListParityRow,
  type SessionListParityScenario,
} from "./session-list-parity-model";

const A = SessionListParityOwner.A;
const B = SessionListParityOwner.B;
const ONE_TO_TEN = "from_1_to_10" satisfies SessionCostBucketId;

const SEMANTIC_ROWS: readonly SessionListParityRow[] = [
  row({
    key: "k1",
    owner: A,
    status: SESSION_STATUS.ACTIVE,
    harness: Harness.Claude,
    model: "alder",
    repositoryFullName: "org/alpha",
    costUsd: 4,
    priority: Priority.Urgent,
    startedAt: "2026-06-10T01:00:00.000Z",
    lastActivityAt: "2026-06-12T05:00:00.000Z",
    updatedAt: "2026-06-12T05:00:00.000Z",
    endedAt: null,
  }),
  row({
    key: "k2",
    owner: A,
    status: SESSION_STATUS.ERROR,
    harness: Harness.Codex,
    model: "birch",
    repositoryFullName: "org/alpha",
    costUsd: 2,
    priority: Priority.High,
    startedAt: "2026-06-10T02:00:00.000Z",
    lastActivityAt: "2026-06-12T04:00:00.000Z",
    updatedAt: "2026-06-12T04:00:00.000Z",
    endedAt: "2026-06-12T04:00:00.000Z",
  }),
  row({
    key: "k3",
    owner: B,
    status: SESSION_STATUS.INACTIVE,
    harness: Harness.Claude,
    model: "cedar",
    repositoryFullName: "org/bravo",
    costUsd: 0.5,
    priority: Priority.Medium,
    startedAt: "2026-06-10T03:00:00.000Z",
    lastActivityAt: "2026-06-12T03:00:00.000Z",
    updatedAt: "2026-06-12T03:00:00.000Z",
    endedAt: "2026-06-12T03:00:00.000Z",
  }),
  row({
    key: "k4",
    owner: A,
    status: SESSION_STATUS.INACTIVE,
    harness: Harness.Claude,
    model: "dune",
    repositoryFullName: "org/alpha",
    costUsd: 6,
    priority: Priority.Low,
    startedAt: "2026-06-10T04:00:00.000Z",
    lastActivityAt: "2026-06-12T02:00:00.000Z",
    updatedAt: "2026-06-12T02:00:00.000Z",
    endedAt: "2026-06-12T02:00:00.000Z",
  }),
  row({
    key: "k5",
    owner: B,
    status: SESSION_STATUS.ACTIVE,
    harness: Harness.Codex,
    model: "ember",
    repositoryFullName: "org/alpha",
    costUsd: null,
    priority: null,
    startedAt: "2026-06-10T05:00:00.000Z",
    lastActivityAt: "2026-06-12T01:00:00.000Z",
    updatedAt: "2026-06-12T01:00:00.000Z",
    endedAt: null,
  }),
];

const byLastActivity = [desc(SessionListField.LastActivity)];
const SET_PRIORITIES = [Priority.Urgent, Priority.High, Priority.Medium];
const ACTIVE_OR_INACTIVE = [SESSION_STATUS.ACTIVE, SESSION_STATUS.INACTIVE];

export const SESSION_LIST_PARITY_SEMANTIC_SCENARIO: SessionListParityScenario =
  {
    name: "compound filters and semantic sorts",
    rows: SEMANTIC_ROWS,
    cases: [
      conform(
        "status asc, all three statuses",
        [anyOf(SessionListField.Priority, SET_PRIORITIES)],
        [asc(SessionListField.Status)],
        ["k1", "k2", "k3"]
      ),
      conform(
        "status desc, all three statuses",
        [anyOf(SessionListField.Priority, SET_PRIORITIES)],
        [desc(SessionListField.Status)],
        ["k3", "k2", "k1"]
      ),
      conform(
        "priority desc, with an unset priority",
        [],
        [desc(SessionListField.Priority)],
        ["k1", "k2", "k3", "k4", "k5"]
      ),
      conform(
        "priority asc, with an unset priority",
        [],
        [asc(SessionListField.Priority)],
        ["k4", "k3", "k2", "k1", "k5"]
      ),
      conform(
        "status, owner and harness",
        [
          anyOf(SessionListField.Status, ACTIVE_OR_INACTIVE),
          anyOf(SessionListField.User, [A]),
          anyOf(SessionListField.Harness, [Harness.Claude]),
        ],
        byLastActivity,
        ["k1", "k4"]
      ),
      conform(
        "repository, set priority, cost bucket and window",
        [
          anyOf(SessionListField.Repo, ["org/alpha"]),
          emptiness(SessionListField.Priority, ListFilterOperator.IsNotEmpty),
          anyOf(SessionListField.Cost, [ONE_TO_TEN]),
          between(
            SessionListField.LastActivity,
            "2026-06-12T03:30:00.000Z",
            "2026-06-12T06:00:00.000Z"
          ),
        ],
        [asc(SessionListField.Cost)],
        ["k2", "k1"]
      ),
      conform(
        "priority with its empty rows, and harness",
        [
          anyOf(SessionListField.Priority, [Priority.Urgent], true),
          anyOf(SessionListField.Harness, [Harness.Codex]),
        ],
        byLastActivity,
        ["k5"]
      ),
      conform(
        "status and owner, no row matches both",
        [
          anyOf(SessionListField.Status, [SESSION_STATUS.ERROR]),
          anyOf(SessionListField.User, [B]),
        ],
        byLastActivity,
        []
      ),
      {
        ...conform(
          "two statuses by start, a middle page",
          [anyOf(SessionListField.Status, ACTIVE_OR_INACTIVE)],
          [desc(SessionListField.Started)],
          ["k4", "k3"]
        ),
        page: { limit: 2, offset: 1 },
        expectedTotal: 4,
      },
    ],
  };
