import {
  type ListFieldCapability,
  type ListIncludeEmptyOperator,
  type ListQueryCapability,
  resolveListQueryCapability,
} from "@repo/api/src/types/list-query-capability";
import {
  type ListFilterClause,
  ListFilterOperator,
  ListQueryRefusal,
} from "@repo/api/src/types/list-query-expression";
import { parseListQueryExpressionValue } from "@repo/api/src/types/list-query-expression-schema";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  CLOUD_SESSION_LIST_QUERY_CAPABILITY,
  DESKTOP_SESSION_LIST_QUERY_CAPABILITY,
} from "@repo/api/src/types/session-list-query-capabilities";
import { describe, expect, it } from "vitest";
import { SESSION_LIST_PARITY_NARROWING_SCENARIO } from "./session-list-parity-conform";
import { SESSION_LIST_PARITY_SCENARIOS } from "./session-list-parity-fixture";
import {
  type DesktopRefusalCase,
  SESSION_LIST_KNOWN_DIVERGENCE_OWNER,
  SESSION_LIST_PARITY_HEADLESS_AUTONOMY,
  SessionListKnownDivergence,
  type SessionListParityCase,
  SessionListParityCaseKind,
  type SessionListParityRow,
} from "./session-list-parity-model";

const TICKET_RE = /^ISS-\d+$/;
const INCLUDE_EMPTY_OPERATORS: readonly ListIncludeEmptyOperator[] = [
  ListFilterOperator.IsAnyOf,
  ListFilterOperator.IsBetween,
];

const allCases = SESSION_LIST_PARITY_SCENARIOS.flatMap((scenario) =>
  scenario.cases.map((parityCase) => ({ scenario, parityCase }))
);

/** A refusal the desktop owes a case for: what it refuses, on which field. */
type RequiredRefusal = { code: ListQueryRefusal; field?: string };

describe("Sessions list parity fixture (ISS-9584)", () => {
  it("writes every query as an expression the wire parser accepts", () => {
    for (const { parityCase } of allCases) {
      expect(
        parseListQueryExpressionValue(parityCase.expression).ok,
        parityCase.name
      ).toBe(true);
    }
  });

  it("keys every row uniquely within its scenario", () => {
    for (const scenario of SESSION_LIST_PARITY_SCENARIOS) {
      const keys = scenario.rows.map((row) => row.key);
      expect(new Set(keys).size, scenario.name).toBe(keys.length);
    }
  });

  it("names only seeded rows in every expectation", () => {
    for (const { scenario, parityCase } of allCases) {
      const keys = new Set(scenario.rows.map((row) => row.key));
      for (const key of expectedKeysOf(parityCase)) {
        expect(keys.has(key), `${parityCase.name} names ${key}`).toBe(true);
      }
    }
  });

  // A conform case whose sort value repeats among the rows it returns would
  // lean on the id tie-break, which the hosts close by different identities.
  it("never lets a conform case depend on a tie", () => {
    for (const { scenario, parityCase } of allCases) {
      if (parityCase.kind !== SessionListParityCaseKind.Conform) {
        continue;
      }
      const returned = scenario.rows.filter((row) =>
        parityCase.expectedKeys.includes(row.key)
      );
      for (const rule of parityCase.expression.sorts ?? []) {
        const values = returned.map((row) => tieValue(row, rule.field));
        expect(
          new Set(values).size,
          `${parityCase.name} sorts ${rule.field}`
        ).toBe(values.length);
      }
    }
  });

  it("ties the identity-tie rows on every key either host orders them by", () => {
    const tieCases = divergenceCases(
      SessionListKnownDivergence.TieOrderByHostIdentity
    );
    expect(tieCases.length).toBeGreaterThan(0);
    for (const { scenario, parityCase } of tieCases) {
      const [first, ...rest] = scenario.rows;
      for (const other of rest) {
        expect(withoutKey(other), parityCase.name).toEqual(withoutKey(first));
      }
      // The desktop closes the tie by `externalSessionId` descending.
      expect(parityCase.desktopExpectedKeys).toEqual(
        scenario.rows
          .map((row) => row.key)
          .sort()
          .reverse()
      );
    }
  });

  // Without a real last-activity tie against id order, dropping the desktop's
  // start-time term would leave the narrowing cases green.
  it("ties the narrowing rows on last activity, with starts against id order", () => {
    const narrowing = SESSION_LIST_PARITY_NARROWING_SCENARIO;
    expect(SESSION_LIST_PARITY_SCENARIOS).toContain(narrowing);
    const { rows } = narrowing;
    expect(new Set(rows.map((tied) => tied.lastActivityAt)).size).toBe(1);
    const byStartDesc = [...rows]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((tied) => tied.key);
    const byIdDesc = rows
      .map((tied) => tied.key)
      .sort()
      .reverse();
    expect(byStartDesc).not.toEqual(byIdDesc);
    expect(narrowing.cases.length).toBeGreaterThan(0);
    for (const parityCase of narrowing.cases) {
      expect(parityCase).toMatchObject({
        kind: SessionListParityCaseKind.Conform,
        expectedKeys: byStartDesc,
      });
    }
  });

  it("ties the recency-tie rows on every key but updatedAt, against id order", () => {
    const tieCases = divergenceCases(
      SessionListKnownDivergence.HydratedTieByCursorOrder
    );
    expect(tieCases.length).toBeGreaterThan(0);
    for (const { scenario, parityCase } of tieCases) {
      const [first, ...rest] = scenario.rows;
      for (const other of rest) {
        expect(withoutKeyOrUpdated(other), parityCase.name).toEqual(
          withoutKeyOrUpdated(first)
        );
      }
      // Cursor order: `updated_at DESC`, then `id DESC`.
      const byCursor = [...scenario.rows]
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || b.key.localeCompare(a.key)
        )
        .map((tied) => tied.key);
      expect(parityCase.desktopExpectedKeys).toEqual(byCursor);
      // Recency must run against id order, or this row reads like the SQL tie.
      expect(byCursor).not.toEqual(
        scenario.rows
          .map((tied) => tied.key)
          .sort()
          .reverse()
      );
    }
  });

  // The desktop derives autonomy on every read; it can only reproduce a
  // headless score or no score.
  it("seeds only desktop-derivable autonomy where a case filters on it", () => {
    for (const { scenario, parityCase } of allCases) {
      const filtersAutonomy = (parityCase.expression.filters ?? []).some(
        (clause) => clause.field === SessionListField.Autonomy
      );
      if (!filtersAutonomy) {
        continue;
      }
      for (const row of scenario.rows) {
        expect(
          [SESSION_LIST_PARITY_HEADLESS_AUTONOMY, null],
          `${parityCase.name}: ${row.key}`
        ).toContain(row.autonomy);
      }
    }
  });

  it("names the ticket that owns every known divergence, and runs each", () => {
    for (const owner of Object.values(SESSION_LIST_KNOWN_DIVERGENCE_OWNER)) {
      expect(owner).toMatch(TICKET_RE);
    }
    for (const divergence of Object.values(SessionListKnownDivergence)) {
      expect(divergenceCases(divergence).length, divergence).toBeGreaterThan(0);
    }
  });

  it("has the desktop refuse, and the cloud serve, every refusal case", () => {
    for (const parityCase of refusalCases()) {
      expect(
        resolveListQueryCapability(
          parityCase.expression,
          DESKTOP_SESSION_LIST_QUERY_CAPABILITY
        ),
        parityCase.name
      ).toMatchObject({
        ok: false,
        refused: { code: parityCase.desktopRefusal },
      });
      expect(
        resolveListQueryCapability(
          parityCase.expression,
          CLOUD_SESSION_LIST_QUERY_CAPABILITY
        ).ok,
        parityCase.name
      ).toBe(true);
    }
  });

  // Derived from the two declarations: a capability the cloud gains and the
  // desktop lacks needs a refusal case before this goes green.
  it("covers every gap between the two host capabilities with a refusal case", () => {
    const refused = refusalCases().flatMap((parityCase) => {
      const resolved = resolveListQueryCapability(
        parityCase.expression,
        DESKTOP_SESSION_LIST_QUERY_CAPABILITY
      );
      return resolved.ok ? [] : [resolved.refused];
    });
    for (const required of requiredRefusals(
      CLOUD_SESSION_LIST_QUERY_CAPABILITY,
      DESKTOP_SESSION_LIST_QUERY_CAPABILITY
    )) {
      expect(
        refused.some(
          (refusal) =>
            refusal.code === required.code &&
            (required.field === undefined ||
              refusal.details.field === required.field)
        ),
        `${required.code} on ${required.field ?? "the list"}`
      ).toBe(true);
    }
  });

  // Derived the other way: everything BOTH hosts serve must run through both
  // reads, or the harness cannot say the two agree on it.
  it("runs every filter shape and sort both hosts serve", () => {
    const run = allCases.filter(
      ({ parityCase }) =>
        parityCase.kind !== SessionListParityCaseKind.DesktopRefusal
    );
    const clauses = run.flatMap(
      ({ parityCase }) => parityCase.expression.filters ?? []
    );
    const sorted = new Set(
      run.flatMap(({ parityCase }) =>
        (parityCase.expression.sorts ?? []).map((rule) => rule.field)
      )
    );
    for (const [field, cloud] of Object.entries(
      CLOUD_SESSION_LIST_QUERY_CAPABILITY.fields
    )) {
      const desktop = DESKTOP_SESSION_LIST_QUERY_CAPABILITY.fields[field];
      if (!desktop) {
        continue;
      }
      if (cloud.sortable && desktop.sortable) {
        expect(sorted.has(field), `sort ${field}`).toBe(true);
      }
      for (const shape of servedShapes(cloud, desktop)) {
        expect(
          clauses.some((clause) => clauseMatchesShape(clause, field, shape)),
          `${field} ${shape.operator} includeEmpty=${String(shape.includeEmpty)}`
        ).toBe(true);
      }
    }
  });
});

type FilterShape = {
  operator: ListFilterOperator;
  /** `undefined` = the clause omits it. */
  includeEmpty: boolean | undefined;
};

function servedShapes(
  cloud: ListFieldCapability,
  desktop: ListFieldCapability
): FilterShape[] {
  const shapes: FilterShape[] = [];
  for (const operator of cloud.operators) {
    if (!desktop.operators.includes(operator)) {
      continue;
    }
    shapes.push({ operator, includeEmpty: undefined });
    if (!isIncludeEmptyOperator(operator)) {
      continue;
    }
    for (const value of cloud.includeEmpty?.[operator] ?? []) {
      if ((desktop.includeEmpty?.[operator] ?? []).includes(value)) {
        shapes.push({ operator, includeEmpty: value });
      }
    }
  }
  return shapes;
}

function clauseMatchesShape(
  clause: ListFilterClause,
  field: string,
  shape: FilterShape
): boolean {
  if (clause.field !== field || clause.operator !== shape.operator) {
    return false;
  }
  const includeEmpty =
    "includeEmpty" in clause ? clause.includeEmpty : undefined;
  return includeEmpty === shape.includeEmpty;
}

function isIncludeEmptyOperator(
  operator: ListFilterOperator
): operator is ListIncludeEmptyOperator {
  return INCLUDE_EMPTY_OPERATORS.some((candidate) => candidate === operator);
}

function requiredRefusals(
  cloud: ListQueryCapability,
  desktop: ListQueryCapability
): RequiredRefusal[] {
  const required: RequiredRefusal[] = [];
  if (desktop.maxSortRules < cloud.maxSortRules) {
    required.push({ code: ListQueryRefusal.TooManySortRules });
  }
  if (desktop.maxClauses < cloud.maxClauses) {
    required.push({ code: ListQueryRefusal.TooManyClauses });
  }
  if (desktop.maxValuesPerClause < cloud.maxValuesPerClause) {
    required.push({ code: ListQueryRefusal.TooManyValues });
  }
  for (const [field, served] of Object.entries(cloud.fields)) {
    required.push(...fieldRefusals(field, served, desktop.fields[field]));
  }
  return required;
}

function fieldRefusals(
  field: string,
  cloud: ListFieldCapability,
  desktop: ListFieldCapability | undefined
): RequiredRefusal[] {
  if (!desktop) {
    return [{ code: ListQueryRefusal.UnsupportedField, field }];
  }
  const required: RequiredRefusal[] = [];
  if (cloud.sortable && !desktop.sortable) {
    required.push({ code: ListQueryRefusal.UnsupportedField, field });
  }
  const missingOperator = cloud.operators.some(
    (operator) => !desktop.operators.includes(operator)
  );
  const missingEmptiness = INCLUDE_EMPTY_OPERATORS.some((operator) =>
    (cloud.includeEmpty?.[operator] ?? []).some(
      (value) => !(desktop.includeEmpty?.[operator] ?? []).includes(value)
    )
  );
  if (missingOperator || missingEmptiness) {
    required.push({ code: ListQueryRefusal.UnsupportedOperator, field });
  }
  return required;
}

function refusalCases(): DesktopRefusalCase[] {
  return allCases.flatMap(({ parityCase }) =>
    parityCase.kind === SessionListParityCaseKind.DesktopRefusal
      ? [parityCase]
      : []
  );
}

function divergenceCases(divergence: SessionListKnownDivergence) {
  return allCases.flatMap(({ scenario, parityCase }) =>
    parityCase.kind === SessionListParityCaseKind.KnownDivergence &&
    parityCase.divergence === divergence
      ? [{ scenario, parityCase }]
      : []
  );
}

function expectedKeysOf(parityCase: SessionListParityCase): readonly string[] {
  switch (parityCase.kind) {
    case SessionListParityCaseKind.Conform:
      return parityCase.expectedKeys;
    case SessionListParityCaseKind.DesktopRefusal:
      return parityCase.cloudExpectedKeys;
    case SessionListParityCaseKind.KnownDivergence:
      return [
        ...parityCase.desktopExpectedKeys,
        ...("keys" in parityCase.cloud
          ? parityCase.cloud.keys
          : parityCase.cloud.byHostIdentityDesc),
      ];
    default:
      return assertNever(parityCase);
  }
}

const SORT_VALUES: Readonly<
  Record<SessionListField, (row: SessionListParityRow) => unknown>
> = {
  [SessionListField.User]: (row) => row.owner,
  [SessionListField.Status]: (row) => row.status,
  [SessionListField.Repo]: (row) => row.repositoryFullName,
  [SessionListField.Harness]: (row) => row.harness,
  [SessionListField.Model]: (row) => row.model,
  [SessionListField.Autonomy]: (row) => row.autonomy,
  [SessionListField.Duration]: (row) =>
    row.endedAt === null
      ? null
      : Date.parse(row.endedAt) - Date.parse(row.startedAt),
  [SessionListField.Cost]: (row) => row.costUsd,
  [SessionListField.Started]: (row) => row.startedAt,
  [SessionListField.Priority]: (row) => row.priority,
  [SessionListField.Updated]: (row) => row.updatedAt,
  [SessionListField.LastActivity]: (row) => row.lastActivityAt,
  [SessionListField.ChangePresence]: (row) => row.linesAdded > 0,
  [SessionListField.PrAssociation]: (row) => row.pullRequest,
  [SessionListField.Quality]: (row) => row.turns > 0,
  [SessionListField.ProjectIds]: () => null,
  [SessionListField.Assignee]: (row) => row.owner,
};

function sortValue(row: SessionListParityRow, field: string): unknown {
  if (!isSessionListField(field)) {
    throw new Error(`no sort value for ${field}`);
  }
  return SORT_VALUES[field](row);
}

function withoutKey(row: SessionListParityRow | undefined) {
  if (!row) {
    return row;
  }
  const { key: _key, ...rest } = row;
  return rest;
}

function assertNever(value: never): never {
  throw new Error(`unhandled parity case: ${JSON.stringify(value)}`);
}

/** Own-property lookup: a field id is expression text. */
function isSessionListField(field: string): field is SessionListField {
  return Object.hasOwn(SORT_VALUES, field);
}

function withoutKeyOrUpdated(row: SessionListParityRow | undefined) {
  if (!row) {
    return row;
  }
  const { key: _key, updatedAt: _updatedAt, ...rest } = row;
  return rest;
}

/**
 * The value a conform case must keep unique. Both hosts narrow a last-activity
 * tie by start time before the id (owner ruling on PR #7961, item 4), so a
 * last-activity rule counts the pair.
 */
function tieValue(row: SessionListParityRow, field: string): unknown {
  return field === SessionListField.LastActivity
    ? `${row.lastActivityAt}|${row.startedAt}`
    : sortValue(row, field);
}
