// PRD-721: the list-agnostic half of lowering a canonical list query
// expression (ISS-9476) to one list's legacy params. Factored out of the
// ISS-9477 Sessions compiler so the Branches compiler lowers through the same
// clause rules: a resolved expression becomes the legacy params the host's one
// request boundary already validates, and nothing here builds a predicate.
//
// A list supplies its field registry, how a range bound is written, and how
// its sorts are written; everything else (operators, emptiness, refusals) is
// shared, so a clause cannot mean one thing on Sessions and another on
// Branches.
//
// `.ts` extensions: see "Relative Imports in Emitted Helpers" in
// `packages/api/AGENTS.md`.
import {
  type ListQueryCapability,
  resolveListQueryCapability,
} from "./list-query-capability.ts";
import {
  type ListFieldRangeLowering,
  type ListFieldSetLowering,
  type ListFieldSpec,
  type ListFilterClause,
  ListFilterOperator,
  type ListFilterScalar,
  type ListIsAnyOfClause,
  type ListIsBetweenClause,
  type ListQueryExpression,
  ListQueryRefusal,
  type ListQueryRefusalDetails,
  type ListQueryRefused,
  type ListSortRule,
} from "./list-query-expression.ts";

/**
 * What the schema receiving the lowered params can take. A lowered param the
 * schema does not accept is refused with the field that asked for it, rather
 * than handed on to a strict schema that would 400 with no refusal code.
 */
export type ListQueryLoweringTarget = {
  acceptedParams: ReadonlySet<string>;
  repeatableParams: ReadonlySet<string>;
};

/** The lowered legacy params, keyed by param name. */
export type ListQueryLoweredValues = Record<
  string,
  ListFilterScalar | string[]
>;

/** One list's half of lowering. */
export type ListQueryLoweringList<TParam extends string> = {
  fields: Readonly<Record<string, ListFieldSpec<TParam>>>;
  /** How one `isBetween` bound is written to its legacy param. */
  writeBound: (bound: ListFilterScalar) => ListFilterScalar;
  /** Writes the expression's sorts, or returns the refusal. */
  writeSorts: (
    sorts: readonly ListSortRule[],
    target: ListQueryLoweringTarget,
    params: ListQueryLoweredValues
  ) => ListQueryRefused | null;
};

export type ListQueryLoweringResult<TParams> =
  | { ok: true; params: TParams }
  | { ok: false; refused: ListQueryRefused };

/**
 * Resolve `expression` against one host's capability, then lower it through
 * `list`. Every refusal carries an ISS-9476 `ListQueryRefusal` code.
 */
export function lowerListQueryExpression<TParam extends string>(
  expression: ListQueryExpression,
  capability: ListQueryCapability,
  target: ListQueryLoweringTarget,
  list: ListQueryLoweringList<TParam>
): ListQueryLoweringResult<ListQueryLoweredValues> {
  const resolved = resolveListQueryCapability(expression, capability);
  if (!resolved.ok) {
    return resolved;
  }
  const params: ListQueryLoweredValues = {};
  const lowered = new Set<string>();
  for (const clause of expression.filters ?? []) {
    // The parser refuses a repeated field, but a caller holding a built
    // expression may not have parsed it; a second clause would overwrite the
    // first clause's param.
    if (lowered.has(clause.field)) {
      return { ok: false, refused: malformed({ field: clause.field }) };
    }
    lowered.add(clause.field);
    const refused = lowerClause(clause, target, params, list);
    if (refused) {
      return { ok: false, refused };
    }
  }
  const refused = list.writeSorts(expression.sorts ?? [], target, params);
  return refused ? { ok: false, refused } : { ok: true, params };
}

export function malformed(details: ListQueryRefusalDetails): ListQueryRefused {
  return { code: ListQueryRefusal.Malformed, details };
}

export function unsupportedField(field: string): ListQueryRefused {
  return { code: ListQueryRefusal.UnsupportedField, details: { field } };
}

function lowerClause<TParam extends string>(
  clause: ListFilterClause,
  target: ListQueryLoweringTarget,
  params: ListQueryLoweredValues,
  list: ListQueryLoweringList<TParam>
): ListQueryRefused | null {
  // Own-property lookup: a field id is request text and may be `__proto__`.
  if (!Object.hasOwn(list.fields, clause.field)) {
    return unsupportedField(clause.field);
  }
  const spec = list.fields[clause.field];
  if (!spec) {
    return unsupportedField(clause.field);
  }
  switch (clause.operator) {
    case ListFilterOperator.IsAnyOf:
      return lowerAnyOf(clause, spec.anyOf, target, params);
    case ListFilterOperator.IsEmpty:
      return writeSet(
        clause,
        spec.anyOf,
        spec.anyOf?.emptyToken === undefined ? null : [spec.anyOf.emptyToken],
        target,
        params
      );
    case ListFilterOperator.IsNotEmpty:
      return writeSet(
        clause,
        spec.anyOf,
        spec.anyOf?.nonEmptyValues ? [...spec.anyOf.nonEmptyValues] : null,
        target,
        params
      );
    case ListFilterOperator.IsBetween:
      return lowerBetween(clause, spec.between, target, params, list);
    default:
      return assertNeverClause(clause);
  }
}

function lowerAnyOf<TParam extends string>(
  clause: ListIsAnyOfClause,
  lowering: ListFieldSetLowering<TParam> | null,
  target: ListQueryLoweringTarget,
  params: ListQueryLoweredValues
): ListQueryRefused | null {
  const values = clause.values.map(String);
  const emptyToken = lowering?.emptyToken;
  if (clause.includeEmpty === undefined) {
    return writeSet(clause, lowering, values, target, params);
  }
  // With no empty token there is no legacy spelling for "keep empty rows"; a
  // plain set would drop that half. A plain set already excludes them.
  if (emptyToken === undefined) {
    return clause.includeEmpty
      ? unservedIncludeEmpty(clause)
      : writeSet(clause, lowering, values, target, params);
  }
  const namesEmptyToken = values.includes(emptyToken);
  if (clause.includeEmpty) {
    const withEmpty = namesEmptyToken ? values : [...values, emptyToken];
    return writeSet(clause, lowering, withEmpty, target, params);
  }
  // ISS-9476 handoff: naming the no-value token while excluding empty rows
  // contradicts itself, and the resolver cannot see the token to catch it.
  if (namesEmptyToken) {
    return malformed({ field: clause.field, operator: clause.operator });
  }
  return writeSet(clause, lowering, values, target, params);
}

/**
 * Write one set lowering. `values` is `null` when the registry has no legacy
 * spelling for what the clause asked (no empty token, no closed non-empty set):
 * the host cannot serve that operator on this field.
 */
function writeSet<TParam extends string>(
  clause: ListFilterClause,
  lowering: ListFieldSetLowering<TParam> | null,
  values: string[] | null,
  target: ListQueryLoweringTarget,
  params: ListQueryLoweredValues
): ListQueryRefused | null {
  if (!lowering || values === null) {
    return unsupportedOperator(clause);
  }
  const { param } = lowering;
  if (!target.acceptedParams.has(param)) {
    return unsupportedField(clause.field);
  }
  if (target.repeatableParams.has(param)) {
    params[param] = values;
    return null;
  }
  // A scalar param (Sessions `quality`) takes exactly one value. The cloud
  // capability's `maxValues: 1` guarantees it on the request path; a
  // caller-built target must not have the rest dropped.
  const [only] = values;
  if (only === undefined || values.length > 1) {
    return {
      code: ListQueryRefusal.TooManyValues,
      details: { field: clause.field, operator: clause.operator },
    };
  }
  params[param] = only;
  return null;
}

function lowerBetween<TParam extends string>(
  clause: ListIsBetweenClause,
  lowering: ListFieldRangeLowering<TParam> | null,
  target: ListQueryLoweringTarget,
  params: ListQueryLoweredValues,
  list: ListQueryLoweringList<TParam>
): ListQueryRefused | null {
  if (!lowering) {
    return unsupportedOperator(clause);
  }
  // A range param keeps or drops empty rows by the field's registry default,
  // and no param spells the other choice.
  if (
    clause.includeEmpty !== undefined &&
    clause.includeEmpty !== lowering.includeEmptyByDefault
  ) {
    return clause.includeEmpty
      ? unservedIncludeEmpty(clause)
      : {
          code: ListQueryRefusal.UnsupportedOperator,
          details: {
            field: clause.field,
            operator: ListFilterOperator.IsNotEmpty,
          },
        };
  }
  const { minParam, maxParam } = lowering;
  if (
    !(
      target.acceptedParams.has(minParam) && target.acceptedParams.has(maxParam)
    )
  ) {
    return unsupportedField(clause.field);
  }
  // The parser refuses a boundless window; a caller-built expression skips the
  // parser, and writing nothing would return an unwindowed read.
  if (clause.min === undefined && clause.max === undefined) {
    return malformed({ field: clause.field, operator: clause.operator });
  }
  if (clause.min !== undefined) {
    params[minParam] = list.writeBound(clause.min);
  }
  if (clause.max !== undefined) {
    params[maxParam] = list.writeBound(clause.max);
  }
  return null;
}

function unsupportedOperator(clause: ListFilterClause): ListQueryRefused {
  return {
    code: ListQueryRefusal.UnsupportedOperator,
    details: { field: clause.field, operator: clause.operator },
  };
}

/**
 * `includeEmpty: true` amounts to OR `isEmpty`, so it is refused under that
 * operator, as `resolveListQueryCapability` refuses an unserved one.
 */
function unservedIncludeEmpty(clause: ListFilterClause): ListQueryRefused {
  return {
    code: ListQueryRefusal.UnsupportedOperator,
    details: { field: clause.field, operator: ListFilterOperator.IsEmpty },
  };
}

function assertNeverClause(clause: never): never {
  throw new Error(`unhandled list filter clause: ${JSON.stringify(clause)}`);
}
