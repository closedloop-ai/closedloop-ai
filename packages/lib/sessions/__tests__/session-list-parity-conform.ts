/**
 * ISS-9584 — the Sessions list parity CONFORM scenario: eight sessions both
 * hosts must return in the same order for every query here, plus the queries
 * only the cloud serves, and each host's order for the legacy params it
 * declares (`SessionListLegacyParamBehavior`). Also the last-activity tie
 * narrowing scenario, which both hosts conform to.
 */
import { Priority } from "@repo/api/src/types/common";
import {
  ListFilterOperator,
  ListQueryRefusal,
} from "@repo/api/src/types/list-query-expression";
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
  refusal,
  row,
  SESSION_LIST_PARITY_PROJECT_ID,
  type SessionListParityCase,
  SessionListParityOwner,
  type SessionListParityRow,
  type SessionListParityScenario,
} from "./session-list-parity-model";

const CLAUDE = Harness.Claude;
const CODEX = Harness.Codex;
const A = SessionListParityOwner.A;
const B = SessionListParityOwner.B;

/**
 * Eight sessions, two owners. Cost, started, last activity, updated and model
 * are each unique across the rows; updated runs in a different order from last
 * activity, so an unsorted read tells the two host defaults apart. Every
 * stored status agrees with its end instant (active rows have none), so the
 * desktop's ended-row reconciliation never fires here. Names are letters only
 * so no collation reorders them on punctuation. `autonomy` here serves only
 * the cloud's half of the autonomy-sort refusal; the evidence scenario covers
 * the autonomy filter.
 */
const CONFORM_ROWS: readonly SessionListParityRow[] = [
  row({
    key: "p01",
    owner: A,
    status: SESSION_STATUS.ACTIVE,
    harness: CLAUDE,
    model: "cedar",
    repositoryFullName: "org/alpha",
    costUsd: 5.25,
    priority: Priority.High,
    autonomy: 90,
    startedAt: "2026-06-10T08:00:00.000Z",
    lastActivityAt: "2026-06-14T10:00:00.000Z",
    updatedAt: "2026-06-12T01:00:00.000Z",
    endedAt: null,
  }),
  row({
    key: "p02",
    owner: A,
    status: SESSION_STATUS.INACTIVE,
    harness: CODEX,
    model: "amber",
    repositoryFullName: "org/bravo",
    costUsd: 0.75,
    priority: Priority.Low,
    autonomy: 50,
    startedAt: "2026-06-12T09:00:00.000Z",
    lastActivityAt: "2026-06-12T11:00:00.000Z",
    updatedAt: "2026-06-14T02:00:00.000Z",
    endedAt: "2026-06-12T11:00:00.000Z",
  }),
  row({
    key: "p03",
    owner: B,
    status: SESSION_STATUS.ACTIVE,
    harness: CLAUDE,
    model: "fjord",
    repositoryFullName: "org/alpha",
    costUsd: 12.5,
    priority: Priority.Urgent,
    autonomy: 20,
    startedAt: "2026-06-08T07:00:00.000Z",
    lastActivityAt: "2026-06-14T08:00:00.000Z",
    updatedAt: "2026-06-10T03:00:00.000Z",
    endedAt: null,
  }),
  row({
    key: "p04",
    owner: B,
    status: SESSION_STATUS.ERROR,
    harness: CODEX,
    model: "birch",
    repositoryFullName: "org/charlie",
    costUsd: 0.2,
    priority: null,
    autonomy: 70,
    startedAt: "2026-06-13T06:00:00.000Z",
    lastActivityAt: "2026-06-13T06:30:00.000Z",
    updatedAt: "2026-06-11T04:00:00.000Z",
    endedAt: "2026-06-13T06:30:00.000Z",
  }),
  row({
    key: "p05",
    owner: A,
    status: SESSION_STATUS.INACTIVE,
    harness: CLAUDE,
    model: "ember",
    repositoryFullName: "org/bravo",
    costUsd: 48,
    priority: Priority.Medium,
    autonomy: 95,
    startedAt: "2026-06-05T12:00:00.000Z",
    lastActivityAt: "2026-06-11T12:00:00.000Z",
    updatedAt: "2026-06-13T05:00:00.000Z",
    endedAt: "2026-06-11T12:00:00.000Z",
  }),
  row({
    key: "p06",
    owner: B,
    status: SESSION_STATUS.INACTIVE,
    harness: CODEX,
    model: "dune",
    repositoryFullName: "org/alpha",
    costUsd: 2.1,
    priority: Priority.High,
    autonomy: 40,
    startedAt: "2026-06-11T15:00:00.000Z",
    lastActivityAt: "2026-06-13T20:00:00.000Z",
    updatedAt: "2026-06-09T06:00:00.000Z",
    endedAt: "2026-06-13T20:00:00.000Z",
  }),
  row({
    key: "p07",
    owner: A,
    status: SESSION_STATUS.ACTIVE,
    harness: CODEX,
    model: "heath",
    repositoryFullName: "org/charlie",
    costUsd: 7.8,
    priority: null,
    autonomy: 10,
    startedAt: "2026-06-14T01:00:00.000Z",
    lastActivityAt: "2026-06-14T12:00:00.000Z",
    updatedAt: "2026-06-08T07:00:00.000Z",
    endedAt: null,
  }),
  row({
    key: "p08",
    owner: B,
    status: SESSION_STATUS.ERROR,
    harness: CLAUDE,
    model: "grove",
    repositoryFullName: "org/bravo",
    costUsd: 1.4,
    priority: Priority.Low,
    autonomy: 60,
    startedAt: "2026-06-09T10:00:00.000Z",
    lastActivityAt: "2026-06-10T09:00:00.000Z",
    updatedAt: "2026-06-15T08:00:00.000Z",
    endedAt: "2026-06-10T09:00:00.000Z",
  }),
];

const BY_LAST_ACTIVITY_DESC = [
  "p07",
  "p01",
  "p03",
  "p06",
  "p04",
  "p02",
  "p05",
  "p08",
] as const;
const BY_UPDATED_DESC = [
  "p08",
  "p02",
  "p05",
  "p01",
  "p04",
  "p03",
  "p06",
  "p07",
] as const;
const BY_STARTED_DESC = [
  "p07",
  "p04",
  "p02",
  "p06",
  "p01",
  "p08",
  "p03",
  "p05",
] as const;

const byLastActivity = [desc(SessionListField.LastActivity)];

const CONFORM_CASES: readonly SessionListParityCase[] = [
  // Filters. Each carries a sort: with none, the hosts use different default
  // orders (declared in SessionListLegacyParamBehavior.unsortedOrder).
  conform(
    "status",
    [anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE])],
    byLastActivity,
    ["p07", "p01", "p03"]
  ),
  conform(
    "status, two values",
    [
      anyOf(SessionListField.Status, [
        SESSION_STATUS.INACTIVE,
        SESSION_STATUS.ERROR,
      ]),
    ],
    byLastActivity,
    ["p06", "p04", "p02", "p05", "p08"]
  ),
  conform(
    "status, includeEmpty false",
    [anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE], false)],
    byLastActivity,
    ["p07", "p01", "p03"]
  ),
  conform("owner", [anyOf(SessionListField.User, [A])], byLastActivity, [
    "p07",
    "p01",
    "p02",
    "p05",
  ]),
  conform(
    "owner, includeEmpty false",
    [anyOf(SessionListField.User, [B], false)],
    byLastActivity,
    ["p03", "p06", "p04", "p08"]
  ),
  conform(
    "harness",
    [anyOf(SessionListField.Harness, [CODEX])],
    byLastActivity,
    ["p07", "p06", "p04", "p02"]
  ),
  conform(
    "harness, includeEmpty false",
    [anyOf(SessionListField.Harness, [CLAUDE], false)],
    byLastActivity,
    ["p01", "p03", "p05", "p08"]
  ),
  conform(
    "model",
    [anyOf(SessionListField.Model, ["amber", "fjord"])],
    byLastActivity,
    ["p03", "p02"]
  ),
  conform(
    "repository",
    [anyOf(SessionListField.Repo, ["org/bravo"])],
    byLastActivity,
    ["p02", "p05", "p08"]
  ),
  conform(
    "repository, includeEmpty false",
    [anyOf(SessionListField.Repo, ["org/charlie"], false)],
    byLastActivity,
    ["p07", "p04"]
  ),
  conform(
    "priority",
    [anyOf(SessionListField.Priority, [Priority.High])],
    byLastActivity,
    ["p01", "p06"]
  ),
  conform(
    "priority isEmpty",
    [emptiness(SessionListField.Priority, ListFilterOperator.IsEmpty)],
    byLastActivity,
    ["p07", "p04"]
  ),
  conform(
    "priority isNotEmpty",
    [emptiness(SessionListField.Priority, ListFilterOperator.IsNotEmpty)],
    byLastActivity,
    ["p01", "p03", "p06", "p02", "p05", "p08"]
  ),
  conform(
    "last activity window",
    [
      between(
        SessionListField.LastActivity,
        "2026-06-12T00:00:00.000Z",
        "2026-06-14T09:00:00.000Z"
      ),
    ],
    byLastActivity,
    ["p03", "p06", "p04", "p02"]
  ),
  conform(
    "status and cost",
    [anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE])],
    [desc(SessionListField.Cost)],
    ["p03", "p07", "p01"]
  ),
  // Sorts over the whole corpus.
  conform(
    "cost asc",
    [],
    [asc(SessionListField.Cost)],
    ["p04", "p02", "p08", "p06", "p01", "p07", "p03", "p05"]
  ),
  conform(
    "cost desc",
    [],
    [desc(SessionListField.Cost)],
    ["p05", "p03", "p07", "p01", "p06", "p08", "p02", "p04"]
  ),
  conform(
    "started asc",
    [],
    [asc(SessionListField.Started)],
    [...BY_STARTED_DESC].reverse()
  ),
  conform(
    "started desc",
    [],
    [desc(SessionListField.Started)],
    BY_STARTED_DESC
  ),
  conform(
    "last activity asc",
    [],
    [asc(SessionListField.LastActivity)],
    [...BY_LAST_ACTIVITY_DESC].reverse()
  ),
  conform("last activity desc", [], byLastActivity, BY_LAST_ACTIVITY_DESC),
  conform(
    "updated asc",
    [],
    [asc(SessionListField.Updated)],
    [...BY_UPDATED_DESC].reverse()
  ),
  conform(
    "updated desc",
    [],
    [desc(SessionListField.Updated)],
    BY_UPDATED_DESC
  ),
  conform(
    "model asc",
    [],
    [asc(SessionListField.Model)],
    ["p02", "p04", "p01", "p06", "p05", "p03", "p08", "p07"]
  ),
  conform(
    "model desc",
    [],
    [desc(SessionListField.Model)],
    ["p07", "p08", "p03", "p05", "p06", "p01", "p04", "p02"]
  ),
  // Sorts on a field that repeats across the corpus, narrowed to rows where
  // it does not.
  conform(
    "priority desc, one harness",
    [anyOf(SessionListField.Harness, [CLAUDE])],
    [desc(SessionListField.Priority)],
    ["p03", "p01", "p05", "p08"]
  ),
  conform(
    "status asc, one repository",
    [anyOf(SessionListField.Repo, ["org/charlie"])],
    [asc(SessionListField.Status)],
    ["p07", "p04"]
  ),
  conform(
    "harness asc, one priority",
    [anyOf(SessionListField.Priority, [Priority.High])],
    [asc(SessionListField.Harness)],
    ["p01", "p06"]
  ),
  conform(
    "repository asc, one status",
    [anyOf(SessionListField.Status, [SESSION_STATUS.ERROR])],
    [asc(SessionListField.Repo)],
    ["p08", "p04"]
  ),
  conform(
    "duration desc, ended rows",
    [anyOf(SessionListField.Status, [SESSION_STATUS.INACTIVE])],
    [desc(SessionListField.Duration)],
    ["p05", "p06", "p02"]
  ),
  {
    ...conform("second page", [], byLastActivity, ["p03", "p06", "p04"]),
    page: { limit: 3, offset: 2 },
    expectedTotal: CONFORM_ROWS.length,
  },
  // What the desktop cannot serve.
  refusal(
    "two sort rules",
    [],
    [asc(SessionListField.Status), desc(SessionListField.Cost)],
    ["p03", "p07", "p01", "p08", "p04", "p05", "p06", "p02"],
    ListQueryRefusal.TooManySortRules
  ),
  refusal(
    "autonomy sort",
    [],
    [desc(SessionListField.Autonomy)],
    ["p05", "p01", "p04", "p08", "p02", "p06", "p03", "p07"],
    ListQueryRefusal.UnsupportedField
  ),
  // No seeded session sits in this project: the cloud serves an empty page;
  // the desktop has no project facet at all.
  refusal(
    "project filter",
    [anyOf(SessionListField.ProjectIds, [SESSION_LIST_PARITY_PROJECT_ID])],
    byLastActivity,
    [],
    ListQueryRefusal.UnsupportedField
  ),
  // ISS-9476 DESKTOP_MODEL: a null model folds to "unknown", so the desktop
  // cannot promise to drop the null-model rows.
  refusal(
    "model, includeEmpty false",
    [anyOf(SessionListField.Model, ["amber", "fjord"], false)],
    byLastActivity,
    ["p03", "p02"],
    ListQueryRefusal.UnsupportedOperator
  ),
  // ISS-9476 DESKTOP_LAST_ACTIVITY: a row with no activity instant is windowed
  // by its start time on the desktop.
  refusal(
    "last activity, includeEmpty false",
    [
      {
        ...between(
          SessionListField.LastActivity,
          "2026-06-12T00:00:00.000Z",
          "2026-06-14T09:00:00.000Z"
        ),
        includeEmpty: false,
      },
    ],
    byLastActivity,
    ["p03", "p06", "p04", "p02"],
    ListQueryRefusal.UnsupportedOperator
  ),
];

/** The corpus the declared legacy-param behaviors are asserted against. */
export const SESSION_LIST_PARITY_CONFORM_SCENARIO: SessionListParityScenario = {
  name: "conform",
  rows: CONFORM_ROWS,
  cases: CONFORM_CASES,
};

/**
 * {@link CONFORM_ROWS} in each host's DEFAULT order — an expression with no
 * sort rule. Cloud: last activity descending. Desktop: `updated_at`
 * descending. Declared, not conformed (`SessionListLegacyParamBehavior`).
 */
export const SESSION_LIST_PARITY_UNSORTED_KEYS = {
  cloud: BY_LAST_ACTIVITY_DESC,
  desktop: BY_UPDATED_DESC,
} as const;

/** What the desktop serves for an unrecognized scalar `sortBy`. */
export const SESSION_LIST_PARITY_STARTED_DESC_KEYS = BY_STARTED_DESC;

/**
 * Three sessions tied on last activity with different starts, keys against
 * the start order. Both hosts narrow the tie by start time descending in
 * either direction (the cloud's `SESSION_DEFAULT_ORDER_BY`; the desktop per
 * the owner ruling on PR #7961, item 4). Closing it by id alone would answer
 * `w-c, w-b, w-a`.
 */
const NARROWING_ROWS: readonly SessionListParityRow[] = [
  row({ key: "w-a", startedAt: "2026-06-10T09:00:00.000Z" }),
  row({ key: "w-b", startedAt: "2026-06-10T07:00:00.000Z" }),
  row({ key: "w-c", startedAt: "2026-06-10T08:00:00.000Z" }),
];
const NARROWED_BY_START = ["w-a", "w-c", "w-b"];

export const SESSION_LIST_PARITY_NARROWING_SCENARIO: SessionListParityScenario =
  {
    name: "last activity tie narrowing",
    rows: NARROWING_ROWS,
    cases: [
      conform(
        "narrowing, last activity desc",
        [],
        [desc(SessionListField.LastActivity)],
        NARROWED_BY_START
      ),
      conform(
        "narrowing, last activity asc",
        [],
        [asc(SessionListField.LastActivity)],
        NARROWED_BY_START
      ),
    ],
  };
