// PRD-721 / ISS-9346: how one list's legacy params relate to the canonical
// list query expression (ISS-9476), read off that list's registry, and the one
// client builder every product grid uses to send `listQuery` instead of the
// legacy filter and sort params.
//
// The builder inverts the registry's legacy-param maps. It writes an
// expression only when the expression says exactly what the legacy params
// said, so a grid that switches to `listQuery` reads the same rows in the same
// order; anything the v1 expression cannot state returns `null` and the caller
// sends the legacy params it always sent.
//
// Zod-free so a bundle-sensitive client can build a request without a
// validator, like `list-query-expression.ts`.
//
// `.ts` extensions: see "Relative Imports in Emitted Helpers" in
// `packages/api/AGENTS.md`.
import {
  type ListQueryCapability,
  resolveListQueryCapability,
} from "./list-query-capability.ts";
import {
  LIST_QUERY_EXPRESSION_MAX_LENGTH,
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  type ListFieldSpec,
  type ListFilterClause,
  ListFilterOperator,
  type ListFilterScalar,
  ListNonFieldParamReason,
  type ListQueryExpression,
  type ListSortRule,
  listFieldLegacyParams,
  serializeListQueryExpression,
} from "./list-query-expression.ts";
import { anchorListQueryWindowBound } from "./list-query-ordering-semantics.ts";

/**
 * The non-field reasons whose params may travel beside `listQuery` (ISS-9477
 * ruling): paging, scope and search. Every other list param spells an axis the
 * expression already speaks, so sending both is refused rather than merged.
 */
const COMPANION_REASONS: ReadonlySet<ListNonFieldParamReason> = new Set([
  ListNonFieldParamReason.Paging,
  ListNonFieldParamReason.Scope,
  ListNonFieldParamReason.Search,
]);

/** One list's legacy vocabulary, as its registry declares it. */
export type ListQueryLegacyVocabulary<TField extends string> = {
  fields: Readonly<Record<TField, ListFieldSpec<string>>>;
  /** Every legacy param that is an axis of a field, aliases included. */
  fieldByLegacyParam: ReadonlyMap<string, TField>;
  /** The legacy params that are not fields, each with its reason. */
  nonFieldParams: Readonly<Record<string, ListNonFieldParamReason>>;
  /** The non-field params that may travel beside `listQuery`. */
  companionParams: ReadonlySet<string>;
};

/**
 * The field each legacy param a field's lowerings read is an axis of, plus any
 * legacy spelling of an axis that no lowering writes (`extraAliases`).
 */
export function listQueryFieldByLegacyParam<TField extends string>(
  fieldIds: readonly TField[],
  fields: Readonly<Record<TField, ListFieldSpec<string>>>,
  extraAliases: Readonly<Record<string, TField>> = {}
): ReadonlyMap<string, TField> {
  const entries: [string, TField][] = fieldIds.flatMap((field) =>
    listFieldLegacyParams(fields[field]).map((param): [string, TField] => [
      param,
      field,
    ])
  );
  entries.push(...Object.entries(extraAliases));
  return new Map(entries);
}

/** The non-field params whose reason lets them travel beside `listQuery`. */
export function listQueryCompanionParams(
  nonFieldParams: Readonly<Record<string, ListNonFieldParamReason>>
): ReadonlySet<string> {
  return new Set(
    Object.entries(nonFieldParams)
      .filter(([, reason]) => COMPANION_REASONS.has(reason))
      .map(([param]) => param)
  );
}

/**
 * Whether `name` spells an axis the expression speaks, or its sort: a request
 * carrying it beside `listQuery` is refused as Malformed rather than merged.
 * A companion, or a param the list does not know (a host read hint such as
 * `countOnly`), travels beside the expression.
 */
export function isListQueryAxisParam<TField extends string>(
  name: string,
  vocabulary: ListQueryLegacyVocabulary<TField>
): boolean {
  if (vocabulary.fieldByLegacyParam.has(name)) {
    return true;
  }
  // Own-property lookup: a param name is request text and may be `__proto__`.
  return (
    Object.hasOwn(vocabulary.nonFieldParams, name) &&
    !vocabulary.companionParams.has(name)
  );
}

/** A legacy list request, split for the builder. */
export type ListQueryLegacyRequest = {
  /** Every param the legacy request would send, sorts included. */
  params: Readonly<Record<string, unknown>>;
  /**
   * The request's sort, read off its legacy sort params by the list's own
   * binding, or `null` when the legacy sort cannot be stated as rules.
   */
  sorts: readonly ListSortRule[] | null;
};

/** The canonical request: the expression plus every param that travels. */
export type ListQueryCanonicalRequest = {
  expression: ListQueryExpression;
  /** Companion params and host read hints, unchanged. */
  companions: Record<string, unknown>;
};

/**
 * THE client builder (ISS-9346): the expression that says exactly what the
 * legacy filter and sort params of `request` say, plus the params that travel
 * beside it, or `null` when no v1 expression says the same thing. A `null`
 * means "send the legacy params", never "send nothing".
 *
 * Returns `null` for: a request with no filter and no sort (its legacy
 * params are already only companions), a param the expression cannot state
 * (an unmodeled bound, an alias spelling), two lowerings of one field at once
 * (one clause per field), a value the parser or `capability` would refuse,
 * and a window bound the receiving host would read differently once anchored. Checking
 * `capability` here is what keeps the switch row-for-row: a host that refuses
 * an expression would answer with an error where the legacy read answered.
 */
export function buildListQueryFromLegacyParams<TField extends string>(
  vocabulary: ListQueryLegacyVocabulary<TField>,
  capability: ListQueryCapability,
  request: ListQueryLegacyRequest
): ListQueryCanonicalRequest | null {
  if (request.sorts === null) {
    return null;
  }
  const split = splitLegacyParams(vocabulary, request.params);
  if (split === null) {
    return null;
  }
  const filters: ListFilterClause[] = [];
  for (const [field, params] of split.byField) {
    const clause = clauseOf(field, vocabulary.fields[field], params);
    if (clause === null) {
      return null;
    }
    filters.push(clause);
  }
  // Nothing to say: the legacy request is already only its companions.
  if (filters.length === 0 && request.sorts.length === 0) {
    return null;
  }
  const expression: ListQueryExpression = {
    version: LIST_QUERY_EXPRESSION_VERSION,
    ...(filters.length > 0 ? { filters } : {}),
    ...(request.sorts.length > 0 ? { sorts: [...request.sorts] } : {}),
  };
  if (!resolveListQueryCapability(expression, capability).ok) {
    return null;
  }
  return { expression, companions: split.companions };
}

/**
 * {@link buildListQueryFromLegacyParams} for a URL: the companions plus the
 * serialized `listQuery` param, or `null` when there is no expression or its
 * serialization is longer than a parser reads.
 */
export function buildListQueryUrlParams<TField extends string>(
  vocabulary: ListQueryLegacyVocabulary<TField>,
  capability: ListQueryCapability,
  request: ListQueryLegacyRequest
): Record<string, unknown> | null {
  const built = buildListQueryFromLegacyParams(vocabulary, capability, request);
  if (built === null) {
    return null;
  }
  const serialized = serializeListQueryExpression(built.expression);
  if (serialized.length > LIST_QUERY_EXPRESSION_MAX_LENGTH) {
    return null;
  }
  return { ...built.companions, [LIST_QUERY_EXPRESSION_PARAM]: serialized };
}

type SplitLegacyParams<TField extends string> = {
  byField: Map<TField, Map<string, unknown>>;
  companions: Record<string, unknown>;
};

/**
 * Sort each param into its field, the companions, or the legacy sort the
 * caller already read. An absent field or axis param (`undefined`, `null`, an
 * empty list) is skipped, the way the legacy serializers skip it; every other
 * param is copied unchanged, because a host may read an empty value there
 * differently from a missing one (desktop `ids`).
 */
function splitLegacyParams<TField extends string>(
  vocabulary: ListQueryLegacyVocabulary<TField>,
  params: Readonly<Record<string, unknown>>
): SplitLegacyParams<TField> | null {
  const byField = new Map<TField, Map<string, unknown>>();
  const companions: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    const field = vocabulary.fieldByLegacyParam.get(name);
    if (field !== undefined) {
      if (!isAbsentParam(value)) {
        const fieldParams = byField.get(field) ?? new Map<string, unknown>();
        fieldParams.set(name, value);
        byField.set(field, fieldParams);
      }
      continue;
    }
    if (isLegacySortParam(name, vocabulary)) {
      continue;
    }
    if (isListQueryAxisParam(name, vocabulary)) {
      if (isAbsentParam(value)) {
        continue;
      }
      return null;
    }
    companions[name] = value;
  }
  return { byField, companions };
}

function isLegacySortParam<TField extends string>(
  name: string,
  vocabulary: ListQueryLegacyVocabulary<TField>
): boolean {
  return (
    Object.hasOwn(vocabulary.nonFieldParams, name) &&
    vocabulary.nonFieldParams[name] === ListNonFieldParamReason.LegacySort
  );
}

function isAbsentParam(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * The one clause the field's present params state, or `null` when they are
 * not exactly one lowering's params (an alias, or a set and a range at once).
 */
function clauseOf(
  field: string,
  spec: ListFieldSpec<string>,
  params: ReadonlyMap<string, unknown>
): ListFilterClause | null {
  const setParam = spec.anyOf?.param;
  if (setParam !== undefined && params.has(setParam)) {
    return params.size === 1 ? anyOfClause(field, params.get(setParam)) : null;
  }
  const range = spec.between;
  if (range === null) {
    return null;
  }
  const rangeParams = [range.minParam, range.maxParam];
  if ([...params.keys()].some((name) => !rangeParams.includes(name))) {
    return null;
  }
  return betweenClause(
    field,
    params.get(range.minParam),
    params.get(range.maxParam)
  );
}

function anyOfClause(field: string, value: unknown): ListFilterClause | null {
  const entries = Array.isArray(value) ? value : [value];
  const values: ListFilterScalar[] = [];
  for (const entry of entries) {
    if (entry === undefined || entry === null) {
      continue;
    }
    if (!isScalarOperand(entry)) {
      return null;
    }
    values.push(entry);
  }
  return values.length > 0
    ? { field, operator: ListFilterOperator.IsAnyOf, values }
    : null;
}

function betweenClause(
  field: string,
  min: unknown,
  max: unknown
): ListFilterClause | null {
  const bounds = [min, max].filter((bound) => bound !== undefined);
  if (!bounds.every(isUnchangedBound)) {
    return null;
  }
  if (typeof min === "number" && typeof max === "number" && min > max) {
    return null;
  }
  if (min !== undefined && max !== undefined && typeof min !== typeof max) {
    return null;
  }
  return {
    field,
    operator: ListFilterOperator.IsBetween,
    ...(isScalarOperand(min) ? { min } : {}),
    ...(isScalarOperand(max) ? { max } : {}),
  };
}

/** What the expression parser reads as one operand. */
function isScalarOperand(value: unknown): value is ListFilterScalar {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * A bound the compiler writes back exactly as the legacy request sent it. A
 * zone-less date-time is anchored to UTC by the lowering (ISS-9585), which a
 * host reading the legacy param on its own clock would not do.
 */
function isUnchangedBound(bound: unknown): boolean {
  return isScalarOperand(bound) && anchorListQueryWindowBound(bound) === bound;
}

/**
 * {@link buildListQueryFromLegacyParams} for a structured transport (desktop
 * IPC): `request` with its field and legacy sort params replaced by the
 * expression under `listQuery`, or `null` when there is no expression.
 */
export function buildListQueryStructuredRequest<
  TRequest extends Readonly<Record<string, unknown>>,
  TField extends string,
>(
  vocabulary: ListQueryLegacyVocabulary<TField>,
  capability: ListQueryCapability,
  request: TRequest,
  sorts: readonly ListSortRule[] | null
): (Partial<TRequest> & { listQuery: ListQueryExpression }) | null {
  const built = buildListQueryFromLegacyParams(vocabulary, capability, {
    params: request,
    sorts,
  });
  if (built === null) {
    return null;
  }
  const kept: Partial<TRequest> = {};
  for (const name of Object.keys(built.companions)) {
    if (isOwnKey(request, name)) {
      Object.assign(kept, { [name]: request[name] });
    }
  }
  return { ...kept, listQuery: built.expression };
}

function isOwnKey<T extends object>(
  value: T,
  key: string
): key is keyof T & string {
  return Object.hasOwn(value, key);
}
