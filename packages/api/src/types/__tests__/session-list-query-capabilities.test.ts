import { describe, expect, it } from "vitest";
import {
  SESSION_COST_FILTER_OPTIONS,
  SESSION_QUALITY_VALUES,
  SESSION_STATUS_FILTER_VALUES,
  SessionChangePresenceId,
  SessionPrAssociationId,
} from "../../agent-session-filters.ts";
import { SESSION_AUTONOMY_TIER_FILTER_OPTIONS } from "../../session-autonomy-tiers.ts";
import { Priority } from "../common.ts";
import { CUSTOM_FIELD_FILTER_MAX_FACETS } from "../custom-field-list-query.ts";
import {
  expressionOf,
  capabilityRefusal as refusalOf,
} from "../list-query.test-helpers.ts";
import { resolveListQueryCapability } from "../list-query-capability.ts";
import {
  LIST_QUERY_MAX_CLAUSES,
  LIST_QUERY_MAX_SORT_RULES,
  LIST_QUERY_MAX_VALUES_PER_CLAUSE,
  type ListFilterClause,
  ListFilterOperator,
  type ListFilterScalar,
  ListQueryRefusal,
} from "../list-query-expression.ts";
import { SessionListField } from "../list-query-fields.ts";
import { PG_TIMESTAMP_MIN_MS } from "../pg-timestamp-floor.ts";
import { PRIORITY_FILTER_VALUES } from "../priority-filter.ts";
import {
  CLOUD_SESSION_LIST_QUERY_CAPABILITY,
  DESKTOP_SESSION_LIST_QUERY_CAPABILITY,
} from "../session-list-query-capabilities.ts";
import { SESSION_LIST_QUERY_FIELDS } from "../session-list-query-registry.ts";

const CLOSED_VOCABULARY_FIELDS = [
  SessionListField.Status,
  SessionListField.Autonomy,
  SessionListField.Cost,
  SessionListField.Priority,
  SessionListField.ChangePresence,
  SessionListField.PrAssociation,
  SessionListField.Quality,
] as const;

/** Each closed field's expected set, named field by field so a swap fails. */
const CANONICAL_VOCABULARY_BY_FIELD = {
  [SessionListField.Status]: SESSION_STATUS_FILTER_VALUES,
  [SessionListField.Autonomy]: SESSION_AUTONOMY_TIER_FILTER_OPTIONS.map(
    (option) => option.value
  ),
  [SessionListField.Cost]: SESSION_COST_FILTER_OPTIONS.map(
    (option) => option.id
  ),
  [SessionListField.Priority]: PRIORITY_FILTER_VALUES,
  [SessionListField.ChangePresence]: Object.values(SessionChangePresenceId),
  [SessionListField.PrAssociation]: Object.values(SessionPrAssociationId),
  [SessionListField.Quality]: SESSION_QUALITY_VALUES,
} satisfies Record<
  (typeof CLOSED_VOCABULARY_FIELDS)[number],
  readonly string[]
>;

/** A v7 UUID, the shape `z.string().uuid()` reads. */
const SAMPLE_UUID = "01a07463-31f5-773e-9fa9-bd1dbdac9f1b";

const FREE_TEXT_FIELDS = [
  SessionListField.Repo,
  SessionListField.Harness,
  SessionListField.Model,
] as const;

const SESSION_DECLARATIONS = [
  ["cloud", CLOUD_SESSION_LIST_QUERY_CAPABILITY],
  ["desktop", DESKTOP_SESSION_LIST_QUERY_CAPABILITY],
] as const;

describe("Sessions capability declarations", () => {
  it.each(SESSION_DECLARATIONS)(
    "%s declares caps no wider than the wire",
    (_host, capability) => {
      expect(capability.maxClauses).toBeLessThanOrEqual(LIST_QUERY_MAX_CLAUSES);
      expect(capability.maxValuesPerClause).toBeLessThanOrEqual(
        LIST_QUERY_MAX_VALUES_PER_CLAUSE
      );
      expect(capability.maxSortRules).toBeLessThanOrEqual(
        LIST_QUERY_MAX_SORT_RULES
      );
    }
  );

  it.each(SESSION_DECLARATIONS)(
    "%s fits a clause on every filterable field plus every custom-field facet",
    (_host, capability) => {
      const filterable = Object.values(capability.fields).filter(
        (served) => served.operators.length > 0
      ).length;
      expect(filterable + CUSTOM_FIELD_FILTER_MAX_FACETS).toBeLessThanOrEqual(
        capability.maxClauses
      );
    }
  );

  it.each(SESSION_DECLARATIONS)(
    "%s declares only what the Sessions registry can lower",
    (_host, capability) => {
      for (const [field, served] of Object.entries(capability.fields)) {
        expect(Object.values(SessionListField)).toContain(field);
        const spec = SESSION_LIST_QUERY_FIELDS[field as SessionListField];
        if (served.sortable) {
          expect(spec.sortRank, `${field} sort rank`).not.toBeNull();
        }
        for (const operator of served.operators) {
          if (operator === ListFilterOperator.IsBetween) {
            expect(spec.between, `${field} between`).not.toBeNull();
          } else {
            expect(spec.anyOf, `${field} anyOf`).not.toBeNull();
          }
          if (operator === ListFilterOperator.IsEmpty) {
            expect(
              spec.anyOf?.emptyToken,
              `${field} empty token`
            ).toBeDefined();
          }
          if (operator === ListFilterOperator.IsNotEmpty) {
            expect(
              spec.anyOf?.nonEmptyValues,
              `${field} non-empty values`
            ).toBeDefined();
          }
        }
      }
    }
  );

  it("cloud serves every Sessions field", () => {
    expect(
      Object.keys(CLOUD_SESSION_LIST_QUERY_CAPABILITY.fields).sort()
    ).toEqual(Object.values(SessionListField).sort());
  });

  it("cloud serves stacked sort rules; desktop applies one", () => {
    const twoRules = expressionOf(
      [],
      [SessionListField.Status, SessionListField.Cost]
    );
    expect(
      resolveListQueryCapability(twoRules, CLOUD_SESSION_LIST_QUERY_CAPABILITY)
    ).toEqual({ ok: true });
    expect(refusalOf(twoRules, DESKTOP_SESSION_LIST_QUERY_CAPABILITY)).toEqual({
      code: ListQueryRefusal.TooManySortRules,
      details: {},
    });
  });

  it("cloud sorts by autonomy; desktop refuses it", () => {
    const byAutonomy = expressionOf([], [SessionListField.Autonomy]);
    expect(
      resolveListQueryCapability(
        byAutonomy,
        CLOUD_SESSION_LIST_QUERY_CAPABILITY
      )
    ).toEqual({ ok: true });
    expect(
      refusalOf(byAutonomy, DESKTOP_SESSION_LIST_QUERY_CAPABILITY)
    ).toEqual({
      code: ListQueryRefusal.UnsupportedField,
      details: { field: SessionListField.Autonomy },
    });
  });

  it("cloud filters by project; desktop refuses it", () => {
    const byProject = expressionOf([
      anyOfValues(SessionListField.ProjectIds, [SAMPLE_UUID]),
    ]);
    expect(
      resolveListQueryCapability(byProject, CLOUD_SESSION_LIST_QUERY_CAPABILITY)
    ).toEqual({ ok: true });
    expect(refusalOf(byProject, DESKTOP_SESSION_LIST_QUERY_CAPABILITY)).toEqual(
      {
        code: ListQueryRefusal.UnsupportedField,
        details: { field: SessionListField.ProjectIds },
      }
    );
  });

  it.each(SESSION_DECLARATIONS)(
    "%s takes one quality value, not two",
    (_host, capability) => {
      expect(
        resolveListQueryCapability(
          expressionOf([qualityOf(SESSION_QUALITY_VALUES.slice(0, 1))]),
          capability
        )
      ).toEqual({ ok: true });
      expect(
        refusalOf(
          expressionOf([qualityOf(SESSION_QUALITY_VALUES.slice(0, 2))]),
          capability
        )
      ).toEqual({
        code: ListQueryRefusal.TooManyValues,
        details: {
          field: SessionListField.Quality,
          operator: ListFilterOperator.IsAnyOf,
        },
      });
    }
  );

  it.each(SESSION_DECLARATIONS)(
    "%s refuses a value outside each closed vocabulary",
    (_host, capability) => {
      for (const field of CLOSED_VOCABULARY_FIELDS) {
        expect(
          refusalOf(
            expressionOf([
              {
                field,
                operator: ListFilterOperator.IsAnyOf,
                values: ["bogus"],
              },
            ]),
            capability
          )
        ).toEqual({
          code: ListQueryRefusal.Malformed,
          details: { field, operator: ListFilterOperator.IsAnyOf },
        });
      }
      expect(
        resolveListQueryCapability(
          expressionOf([
            {
              field: SessionListField.Quality,
              operator: ListFilterOperator.IsAnyOf,
              values: [SESSION_QUALITY_VALUES[1]],
            },
          ]),
          capability
        )
      ).toEqual({ ok: true });
    }
  );

  it("cloud excludes empty model and activity rows on request; desktop cannot", () => {
    const excluding: ListFilterClause[] = [
      {
        field: SessionListField.Model,
        operator: ListFilterOperator.IsAnyOf,
        values: ["m"],
        includeEmpty: false,
      },
      {
        field: SessionListField.LastActivity,
        operator: ListFilterOperator.IsBetween,
        min: "2026-09-01T00:00:00.000Z",
        includeEmpty: false,
      },
    ];
    for (const clause of excluding) {
      expect(
        resolveListQueryCapability(
          expressionOf([clause]),
          CLOUD_SESSION_LIST_QUERY_CAPABILITY
        )
      ).toEqual({ ok: true });
      expect(
        refusalOf(expressionOf([clause]), DESKTOP_SESSION_LIST_QUERY_CAPABILITY)
      ).toEqual({
        code: ListQueryRefusal.UnsupportedOperator,
        details: {
          field: clause.field,
          operator: ListFilterOperator.IsNotEmpty,
        },
      });
    }
  });

  it.each(SESSION_DECLARATIONS)(
    "%s closes each field on its own canonical vocabulary",
    (_host, capability) => {
      for (const [field, expected] of Object.entries(
        CANONICAL_VOCABULARY_BY_FIELD
      )) {
        expect(capability.fields[field]?.values, field).toEqual(expected);
      }
    }
  );

  it.each(SESSION_DECLARATIONS)(
    "%s serves every value of each closed vocabulary",
    (_host, capability) => {
      for (const field of CLOSED_VOCABULARY_FIELDS) {
        const served = capability.fields[field];
        expect(served?.values?.length, `${field} values`).toBeGreaterThan(0);
        for (const value of served?.values ?? []) {
          expect(
            resolveListQueryCapability(
              expressionOf([
                {
                  field,
                  operator: ListFilterOperator.IsAnyOf,
                  values: [value],
                },
              ]),
              capability
            ),
            `${field}=${value}`
          ).toEqual({ ok: true });
        }
      }
    }
  );

  it.each(SESSION_DECLARATIONS)(
    "%s serves includeEmpty on priority and refuses it on repo",
    (_host, capability) => {
      const withEmpty = (field: string): ListFilterClause => ({
        field,
        operator: ListFilterOperator.IsAnyOf,
        values: [Priority.High],
        includeEmpty: true,
      });
      expect(
        resolveListQueryCapability(
          expressionOf([withEmpty(SessionListField.Priority)]),
          capability
        )
      ).toEqual({ ok: true });
      expect(
        refusalOf(expressionOf([withEmpty(SessionListField.Repo)]), capability)
      ).toEqual({
        code: ListQueryRefusal.UnsupportedOperator,
        details: {
          field: SessionListField.Repo,
          operator: ListFilterOperator.IsEmpty,
        },
      });
    }
  );
});

describe("Sessions value formats", () => {
  it.each([SessionListField.User, SessionListField.ProjectIds])(
    "cloud serves a UUID on %s and refuses anything else as Malformed",
    (field) => {
      expect(
        resolveListQueryCapability(
          expressionOf([anyOfValues(field, [SAMPLE_UUID])]),
          CLOUD_SESSION_LIST_QUERY_CAPABILITY
        )
      ).toEqual({ ok: true });
      for (const value of ["not-a-uuid", 7, `${SAMPLE_UUID} `]) {
        expect(
          refusalOf(
            expressionOf([anyOfValues(field, [SAMPLE_UUID, value])]),
            CLOUD_SESSION_LIST_QUERY_CAPABILITY
          ),
          String(value)
        ).toEqual({
          code: ListQueryRefusal.Malformed,
          details: { field, operator: ListFilterOperator.IsAnyOf },
        });
      }
    }
  );

  it("cloud serves a non-blank string on repo, harness and model and refuses a number or a blank", () => {
    for (const field of FREE_TEXT_FIELDS) {
      expect(
        resolveListQueryCapability(
          expressionOf([anyOfValues(field, ["not-a-uuid", " padded "])]),
          CLOUD_SESSION_LIST_QUERY_CAPABILITY
        ),
        field
      ).toEqual({ ok: true });
      for (const value of [7, "   "]) {
        expect(
          refusalOf(
            expressionOf([anyOfValues(field, ["not-a-uuid", value])]),
            CLOUD_SESSION_LIST_QUERY_CAPABILITY
          ),
          `${field} ${value}`
        ).toEqual({
          code: ListQueryRefusal.Malformed,
          details: { field, operator: ListFilterOperator.IsAnyOf },
        });
      }
    }
  });

  it("desktop serves a non-blank string and refuses a number or a blank on each free-text facet", () => {
    for (const field of [SessionListField.User, ...FREE_TEXT_FIELDS]) {
      expect(
        resolveListQueryCapability(
          expressionOf([anyOfValues(field, ["not-a-uuid", " padded "])]),
          DESKTOP_SESSION_LIST_QUERY_CAPABILITY
        ),
        field
      ).toEqual({ ok: true });
      for (const value of [7, "   "]) {
        expect(
          refusalOf(
            expressionOf([anyOfValues(field, ["not-a-uuid", value])]),
            DESKTOP_SESSION_LIST_QUERY_CAPABILITY
          ),
          `${field} ${value}`
        ).toEqual({
          code: ListQueryRefusal.Malformed,
          details: { field, operator: ListFilterOperator.IsAnyOf },
        });
      }
    }
  });

  it.each(SESSION_DECLARATIONS)(
    "%s serves a parsable lastActivity bound and refuses any other",
    (_host, capability) => {
      expect(
        resolveListQueryCapability(
          expressionOf([lastActivityBetween("2026-09-01", "2026-09-24")]),
          capability
        )
      ).toEqual({ ok: true });
      const refusedBounds: [
        ListFilterScalar | undefined,
        ListFilterScalar | undefined,
      ][] = [
        ["2026-09-01", "not-a-date"],
        [1_790_000_000_000, undefined],
        [undefined, " "],
      ];
      for (const [min, max] of refusedBounds) {
        expect(
          refusalOf(expressionOf([lastActivityBetween(min, max)]), capability),
          `${min}..${max}`
        ).toEqual({
          code: ListQueryRefusal.Malformed,
          details: {
            field: SessionListField.LastActivity,
            operator: ListFilterOperator.IsBetween,
          },
        });
      }
    }
  );

  it("cloud refuses a lastActivity bound below the Postgres floor and desktop serves it", () => {
    const atFloor = new Date(PG_TIMESTAMP_MIN_MS).toISOString();
    const belowFloor = new Date(PG_TIMESTAMP_MIN_MS - 1).toISOString();
    expect(
      resolveListQueryCapability(
        expressionOf([lastActivityBetween(atFloor, undefined)]),
        CLOUD_SESSION_LIST_QUERY_CAPABILITY
      )
    ).toEqual({ ok: true });
    expect(
      refusalOf(
        expressionOf([lastActivityBetween(undefined, belowFloor)]),
        CLOUD_SESSION_LIST_QUERY_CAPABILITY
      )
    ).toEqual({
      code: ListQueryRefusal.Malformed,
      details: {
        field: SessionListField.LastActivity,
        operator: ListFilterOperator.IsBetween,
      },
    });
    expect(
      resolveListQueryCapability(
        expressionOf([lastActivityBetween(belowFloor, undefined)]),
        DESKTOP_SESSION_LIST_QUERY_CAPABILITY
      )
    ).toEqual({ ok: true });
  });
});

function anyOfValues(
  field: string,
  values: ListFilterScalar[]
): ListFilterClause {
  return { field, operator: ListFilterOperator.IsAnyOf, values };
}

function lastActivityBetween(
  min: ListFilterScalar | undefined,
  max: ListFilterScalar | undefined
): ListFilterClause {
  return {
    field: SessionListField.LastActivity,
    operator: ListFilterOperator.IsBetween,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

function qualityOf(values: readonly string[]): ListFilterClause {
  return {
    field: SessionListField.Quality,
    operator: ListFilterOperator.IsAnyOf,
    values: [...values],
  };
}
