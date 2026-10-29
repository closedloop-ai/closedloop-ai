// ISS-9476: what one host can serve for one list, and the pure check of an
// expression against it. Follows ISS-9481's pattern
// (`custom-field-capabilities.ts`): a host DECLARES what it serves so a caller
// can disable a control, and anything outside the declaration is refused with a
// reason — never approximated, never dropped.
import {
  type LIST_QUERY_EXPRESSION_VERSION,
  type ListFilterClause,
  ListFilterOperator,
  type ListFilterScalar,
  type ListIsBetweenClause,
  type ListQueryExpression,
  ListQueryRefusal,
  type ListQueryRefusalDetails,
  type ListQueryRefused,
} from "./list-query-expression.ts";
import { isBelowPgTimestampFloor } from "./pg-timestamp-floor.ts";

/** zod 4's `z.string().uuid()` pattern (`zod/v4/core/regexes.js`, `uuid()`). */
const UUID_PATTERN =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

/** The two operators that carry an optional `includeEmpty`. */
export type ListIncludeEmptyOperator =
  | typeof ListFilterOperator.IsAnyOf
  | typeof ListFilterOperator.IsBetween;

/**
 * The scalar shape a host's legacy param reads for one field. A value outside
 * it is refused as Malformed rather than handed to a host that would reject it,
 * or drop it and widen the read.
 */
export const ListFieldValueFormat = {
  /** An RFC 9562 UUID: the pattern zod's `z.string().uuid()` reads. */
  Uuid: "uuid",
  /** A string that is not blank once trimmed: zod's `z.string().trim().min(1)`. */
  NonBlankString: "nonBlankString",
  /** A string `Date.parse` reads. */
  Timestamp: "timestamp",
  /** A {@link ListFieldValueFormat.Timestamp} a Postgres `timestamp` can hold. */
  PgTimestamp: "pgTimestamp",
} as const;
export type ListFieldValueFormat =
  (typeof ListFieldValueFormat)[keyof typeof ListFieldValueFormat];

/** What a host can do with one field. */
export type ListFieldCapability = {
  /** Operators the host serves on this field. Empty means filter-less. */
  operators: readonly ListFilterOperator[];
  sortable: boolean;
  /** A per-field value cap below the list's `maxValuesPerClause`. */
  maxValues?: number;
  /**
   * The closed set of `isAnyOf` values the host reads, where its vocabulary is
   * closed. A value outside it is refused as Malformed rather than passed to a
   * host that would fail open on it.
   */
  values?: readonly string[];
  /** The shape of every `isAnyOf` value and `isBetween` bound the host reads. */
  valueFormat?: ListFieldValueFormat;
  /**
   * The EXPLICIT `includeEmpty` values the host serves, per operator. A clause
   * that omits `includeEmpty` asks for the field's registry default and is
   * always served; one that states a value outside this list is refused, in
   * either direction — a host whose range keeps empty rows cannot drop them
   * any more than one that drops them can keep them.
   */
  includeEmpty?: Partial<Record<ListIncludeEmptyOperator, readonly boolean[]>>;
};

/**
 * One (list × host) declaration. Every cap is at or below the parser's wire
 * ceiling (`LIST_QUERY_MAX_*` in `list-query-expression.ts`).
 */
export type ListQueryCapability = {
  version: typeof LIST_QUERY_EXPRESSION_VERSION;
  fields: Readonly<Record<string, ListFieldCapability>>;
  maxClauses: number;
  maxValuesPerClause: number;
  maxSortRules: number;
};

export type ListQueryCapabilityResult =
  | { ok: true }
  | { ok: false; refused: ListQueryRefused };

/**
 * Check a parsed expression against one host's declaration.
 *
 * The version is not rechecked: the parser refuses any version it does not
 * read, so a parsed expression is always one the declaration's version names.
 * A sort on a field the host cannot sort by is `UnsupportedField` — the sort
 * rule names the field and nothing else.
 *
 * Read by every list compiler, the ISS-9584 parity harness, and the grid
 * clients' builder, which checks an expression before it sends one.
 */
export function resolveListQueryCapability(
  expression: ListQueryExpression,
  capability: ListQueryCapability
): ListQueryCapabilityResult {
  const filters = expression.filters ?? [];
  const sorts = expression.sorts ?? [];
  if (filters.length > capability.maxClauses) {
    return refused(ListQueryRefusal.TooManyClauses, {});
  }
  if (sorts.length > capability.maxSortRules) {
    return refused(ListQueryRefusal.TooManySortRules, {});
  }
  for (const clause of filters) {
    const clauseRefusal = refuseClause(clause, capability);
    if (clauseRefusal) {
      return { ok: false, refused: clauseRefusal };
    }
  }
  for (const rule of sorts) {
    if (!fieldCapability(capability, rule.field)?.sortable) {
      return refused(ListQueryRefusal.UnsupportedField, { field: rule.field });
    }
  }
  return { ok: true };
}

function refuseClause(
  clause: ListFilterClause,
  capability: ListQueryCapability
): ListQueryRefused | null {
  const { field, operator } = clause;
  const served = fieldCapability(capability, field);
  if (!served) {
    return { code: ListQueryRefusal.UnsupportedField, details: { field } };
  }
  if (!served.operators.includes(operator)) {
    return {
      code: ListQueryRefusal.UnsupportedOperator,
      details: { field, operator },
    };
  }
  const emptinessRefusal = refuseIncludeEmpty(clause, served);
  if (emptinessRefusal) {
    return emptinessRefusal;
  }
  if (clause.operator === ListFilterOperator.IsAnyOf) {
    return refuseValues(clause.values, served, capability, field);
  }
  if (clause.operator === ListFilterOperator.IsBetween) {
    return refuseBounds(clause, served);
  }
  return null;
}

function refuseValues(
  values: readonly ListFilterScalar[],
  served: ListFieldCapability,
  capability: ListQueryCapability,
  field: string
): ListQueryRefused | null {
  const operator = ListFilterOperator.IsAnyOf;
  if (values.length > valueCap(served, capability)) {
    return {
      code: ListQueryRefusal.TooManyValues,
      details: { field, operator },
    };
  }
  const { values: closed, valueFormat } = served;
  if (
    (closed && values.some((value) => !closed.includes(String(value)))) ||
    values.some((value) => !matchesValueFormat(value, valueFormat))
  ) {
    return {
      code: ListQueryRefusal.Malformed,
      details: { field, operator },
    };
  }
  return null;
}

function refuseBounds(
  clause: ListIsBetweenClause,
  served: ListFieldCapability
): ListQueryRefused | null {
  const bounds = [clause.min, clause.max].filter(
    (bound): bound is ListFilterScalar => bound !== undefined
  );
  if (bounds.every((bound) => matchesValueFormat(bound, served.valueFormat))) {
    return null;
  }
  return {
    code: ListQueryRefusal.Malformed,
    details: { field: clause.field, operator: ListFilterOperator.IsBetween },
  };
}

function matchesValueFormat(
  value: ListFilterScalar,
  format: ListFieldValueFormat | undefined
): boolean {
  switch (format) {
    case undefined:
      return true;
    case ListFieldValueFormat.Uuid:
      return typeof value === "string" && UUID_PATTERN.test(value);
    case ListFieldValueFormat.NonBlankString:
      return typeof value === "string" && value.trim().length > 0;
    case ListFieldValueFormat.Timestamp:
      return typeof value === "string" && Number.isFinite(Date.parse(value));
    case ListFieldValueFormat.PgTimestamp:
      return (
        typeof value === "string" &&
        Number.isFinite(Date.parse(value)) &&
        !isBelowPgTimestampFloor(Date.parse(value))
      );
    default:
      return assertNeverFormat(format);
  }
}

function assertNeverFormat(format: never): never {
  throw new Error(`Unhandled list field value format: ${String(format)}`);
}

/**
 * An unserved `includeEmpty` names the emptiness operator it amounts to:
 * keeping empty rows is OR `isEmpty`, dropping them is AND `isNotEmpty`.
 */
function refuseIncludeEmpty(
  clause: ListFilterClause,
  served: ListFieldCapability
): ListQueryRefused | null {
  if (!("includeEmpty" in clause) || clause.includeEmpty === undefined) {
    return null;
  }
  const servedValues = served.includeEmpty?.[clause.operator] ?? [];
  if (servedValues.includes(clause.includeEmpty)) {
    return null;
  }
  return {
    code: ListQueryRefusal.UnsupportedOperator,
    details: {
      field: clause.field,
      operator: clause.includeEmpty
        ? ListFilterOperator.IsEmpty
        : ListFilterOperator.IsNotEmpty,
    },
  };
}

function valueCap(
  served: ListFieldCapability,
  capability: ListQueryCapability
): number {
  return Math.min(
    capability.maxValuesPerClause,
    served.maxValues ?? capability.maxValuesPerClause
  );
}

/** Own-property lookup: a field id is request text and may be `__proto__`. */
function fieldCapability(
  capability: ListQueryCapability,
  field: string
): ListFieldCapability | undefined {
  return Object.hasOwn(capability.fields, field)
    ? capability.fields[field]
    : undefined;
}

function refused(
  code: ListQueryRefusal,
  details: ListQueryRefusalDetails
): ListQueryCapabilityResult {
  return { ok: false, refused: { code, details } };
}
