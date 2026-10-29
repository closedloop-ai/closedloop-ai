/**
 * ISS-9584 (PRD-721) — the Sessions list parity corpus: its row and case
 * shapes, the owner binding each host applies, and the builders the scenario
 * modules write rows and cases with. The scenarios themselves live beside it;
 * `session-list-parity-fixture.ts` gathers them.
 *
 * Pure data and pure functions: no test runner, no database, no Electron.
 */
import type { Priority } from "@repo/api/src/types/common";
import {
  LIST_QUERY_EXPRESSION_VERSION,
  type ListEmptinessClause,
  type ListFilterClause,
  ListFilterOperator,
  type ListIsAnyOfClause,
  type ListIsBetweenClause,
  type ListQueryExpression,
  type ListQueryRefusal,
  ListSortDirection,
  type ListSortRule,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { Harness } from "../../harness/types";

/** A project no seeded session belongs to. */
export const SESSION_LIST_PARITY_PROJECT_ID =
  "00000000-0000-4000-8000-000000009584";

/**
 * The autonomy score the desktop derives for a headless (SDK-launched) session
 * with agent activity. The desktop computes autonomy from events on every read,
 * so a row the desktop filters by autonomy holds this or `null`.
 */
export const SESSION_LIST_PARITY_HEADLESS_AUTONOMY = 100;

/** The two org members every scenario draws from. */
export const SessionListParityOwner = {
  A: "ownerA",
  B: "ownerB",
} as const;
export type SessionListParityOwner =
  (typeof SessionListParityOwner)[keyof typeof SessionListParityOwner];

/**
 * Each owner's name on both hosts. Chosen so a lowercase code-unit compare and
 * `localeCompare` disagree: "zed adams" < "émile brun" by code unit (0x7A <
 * 0xE9), the other way round by locale.
 */
export const SESSION_LIST_PARITY_OWNER_NAMES: Readonly<
  Record<SessionListParityOwner, { firstName: string; lastName: string }>
> = {
  [SessionListParityOwner.A]: { firstName: "Zed", lastName: "Adams" },
  [SessionListParityOwner.B]: { firstName: "Émile", lastName: "Brun" },
};

/** How a row is linked to a pull request. */
export const SessionListParityPullRequest = {
  None: "none",
  /** A workspace PR link: both hosts count it. */
  Linked: "linked",
  /**
   * An authored PR with no branch write. The cloud counts it; the desktop
   * drops an authored PR it cannot place on a branch.
   */
  AuthoredWithoutBranch: "authoredWithoutBranch",
} as const;
export type SessionListParityPullRequest =
  (typeof SessionListParityPullRequest)[keyof typeof SessionListParityPullRequest];

export type SessionListParityRow = {
  /** `externalSessionId` on cloud, `sessions.id` on desktop. */
  key: string;
  owner: SessionListParityOwner;
  /** The PERSISTED lifecycle status. */
  status: SessionStatus;
  harness: Harness;
  model: string | null;
  repositoryFullName: string;
  /**
   * The cost both hosts price the row at. `null` = none measured: no
   * `token_usage` row on desktop, a null `estimatedCost` on cloud.
   */
  costUsd: number | null;
  /**
   * A cost only the session TOTAL carries: cloud `estimatedCost`, desktop
   * `sessions.cost_usd_estimated` with no `token_usage` row. Set only on the
   * cost-source divergence row.
   */
  sessionTotalCostUsd?: number;
  /** Cloud `turns`; desktop `metadata.userMessages`. Above 0 is substantive. */
  turns: number;
  /** Cloud `linesAdded`; desktop `metadata.diffStats.linesAdded`. */
  linesAdded: number;
  pullRequest: SessionListParityPullRequest;
  priority: Priority | null;
  /**
   * Cloud `autonomy`. The desktop derives it: a row holding
   * {@link SESSION_LIST_PARITY_HEADLESS_AUTONOMY} is seeded headless there.
   */
  autonomy: number | null;
  startedAt: string;
  lastActivityAt: string;
  /**
   * The record-mutation instant: desktop `sessions.updated_at`, cloud both
   * `updated_at` columns the `updated` sort takes the later of.
   */
  updatedAt: string;
  endedAt: string | null;
};

export const SessionListParityCaseKind = {
  Conform: "conform",
  DesktopRefusal: "desktopRefusal",
  KnownDivergence: "knownDivergence",
} as const;
export type SessionListParityCaseKind =
  (typeof SessionListParityCaseKind)[keyof typeof SessionListParityCaseKind];

/** Why the hosts disagree on a {@link KnownDivergenceCase}. */
export const SessionListKnownDivergence = {
  TieOrderByHostIdentity: "tieOrderByHostIdentity",
  HydratedTieByCursorOrder: "hydratedTieByCursorOrder",
  OwnerCollation: "ownerCollation",
  ModelUnknownFold: "modelUnknownFold",
  PullRequestWithoutBranch: "pullRequestWithoutBranch",
  CostSource: "costSource",
} as const;
export type SessionListKnownDivergence =
  (typeof SessionListKnownDivergence)[keyof typeof SessionListKnownDivergence];

/**
 * The ticket that owns each divergence. ISS-9585 settles list semantics
 * (ISS-9584's portfolio boundary). The two tie rows are ISS-9584's own
 * rulings, both accepted by the owner on PR #7961: the hosts key a session by
 * different identities, and the desktop hydrated tier closes a tie by cursor
 * recency before identity.
 */
export const SESSION_LIST_KNOWN_DIVERGENCE_OWNER: Readonly<
  Record<SessionListKnownDivergence, string>
> = {
  [SessionListKnownDivergence.TieOrderByHostIdentity]: "ISS-9584",
  [SessionListKnownDivergence.HydratedTieByCursorOrder]: "ISS-9584",
  [SessionListKnownDivergence.OwnerCollation]: "ISS-9585",
  [SessionListKnownDivergence.ModelUnknownFold]: "ISS-9585",
  [SessionListKnownDivergence.PullRequestWithoutBranch]: "ISS-9585",
  [SessionListKnownDivergence.CostSource]: "ISS-9585",
};

/** Paging beside the expression; absent means the host's default first page. */
export type SessionListParityPage = { limit: number; offset: number };

type CaseBase = {
  name: string;
  expression: ListQueryExpression;
  page?: SessionListParityPage;
  /**
   * The `total` a paged case reports: the filtered population its keys are a
   * page of. An unpaged case's total is its key count ({@link parityTotalOf}).
   */
  expectedTotal?: number;
  /**
   * The process zone each host runs the case in. Only the offsetless-window
   * row sets it: the cloud runs in UTC, a desktop in its user's zone.
   */
  timeZones?: { cloud: string; desktop: string };
};

export type ConformCase = CaseBase & {
  kind: typeof SessionListParityCaseKind.Conform;
  expectedKeys: readonly string[];
};

export type DesktopRefusalCase = CaseBase & {
  kind: typeof SessionListParityCaseKind.DesktopRefusal;
  cloudExpectedKeys: readonly string[];
  desktopRefusal: ListQueryRefusal;
};

/**
 * What the cloud returns for a known divergence. `byHostIdentityDesc` is the
 * identity tie: the rows tie on every key either host orders by, so the cloud
 * orders them by its own `artifactId` descending, which only its runner sees.
 */
export type CloudDivergenceExpectation =
  | { keys: readonly string[] }
  | { byHostIdentityDesc: readonly string[] };

export type KnownDivergenceCase = CaseBase & {
  kind: typeof SessionListParityCaseKind.KnownDivergence;
  divergence: SessionListKnownDivergence;
  cloud: CloudDivergenceExpectation;
  desktopExpectedKeys: readonly string[];
};

export type SessionListParityCase =
  | ConformCase
  | DesktopRefusalCase
  | KnownDivergenceCase;

export type SessionListParityScenario = {
  name: string;
  rows: readonly SessionListParityRow[];
  cases: readonly SessionListParityCase[];
};

/**
 * Replace owner keys in `user` clause values with the host's own user ids.
 * The cloud reads `userIds` as UUIDs; the desktop reads `sessions.user_id`.
 */
export function bindParityOwners(
  expression: ListQueryExpression,
  ownerIds: Readonly<Record<SessionListParityOwner, string>>
): ListQueryExpression {
  if (!expression.filters) {
    return expression;
  }
  return {
    ...expression,
    filters: expression.filters.map((clause) =>
      clause.field === SessionListField.User &&
      clause.operator === ListFilterOperator.IsAnyOf
        ? {
            ...clause,
            values: clause.values.map((value) =>
              isParityOwner(value) ? ownerIds[value] : value
            ),
          }
        : clause
    ),
  };
}

/** Every field a scenario row does not state. Read by `row()` at module load. */
const ROW_DEFAULTS: Omit<SessionListParityRow, "key"> = {
  owner: SessionListParityOwner.A,
  status: SESSION_STATUS.INACTIVE,
  harness: Harness.Claude,
  model: "amber",
  repositoryFullName: "org/alpha",
  costUsd: 1,
  turns: 0,
  linesAdded: 0,
  pullRequest: SessionListParityPullRequest.None,
  priority: null,
  autonomy: null,
  startedAt: "2026-06-10T08:00:00.000Z",
  lastActivityAt: "2026-06-12T08:00:00.000Z",
  updatedAt: "2026-06-12T08:00:00.000Z",
  // No default end: a row that states its own activity must never end before it.
  endedAt: null,
};

export function row(
  fields: Partial<SessionListParityRow> & Pick<SessionListParityRow, "key">
): SessionListParityRow {
  return { ...ROW_DEFAULTS, ...fields };
}

function expression(
  filters: readonly ListFilterClause[],
  sorts: readonly ListSortRule[]
): ListQueryExpression {
  return {
    version: LIST_QUERY_EXPRESSION_VERSION,
    ...(filters.length > 0 ? { filters: [...filters] } : {}),
    ...(sorts.length > 0 ? { sorts: [...sorts] } : {}),
  };
}

export function conform(
  name: string,
  filters: readonly ListFilterClause[],
  sorts: readonly ListSortRule[],
  expectedKeys: readonly string[]
): ConformCase {
  return {
    kind: SessionListParityCaseKind.Conform,
    name,
    expression: expression(filters, sorts),
    expectedKeys,
  };
}

export function refusal(
  name: string,
  filters: readonly ListFilterClause[],
  sorts: readonly ListSortRule[],
  cloudExpectedKeys: readonly string[],
  desktopRefusal: ListQueryRefusal
): DesktopRefusalCase {
  return {
    kind: SessionListParityCaseKind.DesktopRefusal,
    name,
    expression: expression(filters, sorts),
    cloudExpectedKeys,
    desktopRefusal,
  };
}

export function divergence(
  name: string,
  kind: SessionListKnownDivergence,
  filters: readonly ListFilterClause[],
  sorts: readonly ListSortRule[],
  cloud: CloudDivergenceExpectation,
  desktopExpectedKeys: readonly string[]
): KnownDivergenceCase {
  return {
    kind: SessionListParityCaseKind.KnownDivergence,
    name,
    divergence: kind,
    expression: expression(filters, sorts),
    cloud,
    desktopExpectedKeys,
  };
}

export function anyOf(
  field: SessionListField,
  values: string[],
  includeEmpty?: boolean
): ListIsAnyOfClause {
  return {
    field,
    operator: ListFilterOperator.IsAnyOf,
    values,
    ...(includeEmpty === undefined ? {} : { includeEmpty }),
  };
}

export function emptiness(
  field: SessionListField,
  operator:
    | typeof ListFilterOperator.IsEmpty
    | typeof ListFilterOperator.IsNotEmpty
): ListEmptinessClause {
  return { field, operator };
}

export function between(
  field: SessionListField,
  min: string,
  max: string
): ListIsBetweenClause {
  return { field, operator: ListFilterOperator.IsBetween, min, max };
}

export function asc(field: SessionListField): ListSortRule {
  return { field, direction: ListSortDirection.Asc };
}

export function desc(field: SessionListField): ListSortRule {
  return { field, direction: ListSortDirection.Desc };
}

/** A scenario's cases of one kind, narrowed to that kind's case type. */
export function parityCasesOf<K extends SessionListParityCaseKind>(
  scenario: SessionListParityScenario,
  kind: K
): Extract<SessionListParityCase, { kind: K }>[] {
  return scenario.cases.filter(
    (parityCase): parityCase is Extract<SessionListParityCase, { kind: K }> =>
      parityCase.kind === kind
  );
}

function isParityOwner(value: unknown): value is SessionListParityOwner {
  return Object.values<unknown>(SessionListParityOwner).includes(value);
}

/** The `total` a host reports for a case that returns `keys` (ISS-9483). */
export function parityTotalOf(
  parityCase: Pick<CaseBase, "expectedTotal">,
  keys: readonly string[]
): number {
  return parityCase.expectedTotal ?? keys.length;
}

/** The ordered keys one host's list read returned, and its `total` (ISS-9483). */
export type SessionListParityRead = { keys: string[]; total: number };
