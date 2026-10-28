import { z } from "zod";
import {
  LIST_QUERY_EXPRESSION_MAX_LENGTH,
  LIST_QUERY_EXPRESSION_VERSION,
  LIST_QUERY_MAX_CLAUSES,
  LIST_QUERY_MAX_SORT_RULES,
  LIST_QUERY_MAX_VALUES_PER_CLAUSE,
  type ListEmptinessClause,
  ListFilterOperator,
  type ListIsAnyOfClause,
  type ListIsBetweenClause,
  type ListQueryExpression,
  ListQueryRefusal,
  type ListQueryRefusalDetails,
  type ListQueryRefused,
  ListSortDirection,
  type ListSortRule,
} from "./list-query-expression.ts";

const fieldIdSchema = z.string().min(1);

/**
 * A flat scalar. An array or object here is the "unbounded depth" the
 * expression refuses: v1 has no nesting anywhere, so nothing below a clause's
 * value list is ever a container.
 */
const scalarSchema = z.union([z.string().min(1), z.number().finite()]);

const isAnyOfClauseShape = {
  field: fieldIdSchema,
  operator: z.literal(ListFilterOperator.IsAnyOf),
  values: z.array(scalarSchema).min(1).max(LIST_QUERY_MAX_VALUES_PER_CLAUSE),
  includeEmpty: z.boolean().optional(),
} satisfies Record<keyof ListIsAnyOfClause, z.ZodTypeAny>;

const isBetweenClauseShape = {
  field: fieldIdSchema,
  operator: z.literal(ListFilterOperator.IsBetween),
  min: scalarSchema.optional(),
  max: scalarSchema.optional(),
  includeEmpty: z.boolean().optional(),
} satisfies Record<keyof ListIsBetweenClause, z.ZodTypeAny>;

const emptinessClauseShape = {
  field: fieldIdSchema,
  operator: z.enum([ListFilterOperator.IsEmpty, ListFilterOperator.IsNotEmpty]),
} satisfies Record<keyof ListEmptinessClause, z.ZodTypeAny>;

const sortRuleShape = {
  field: fieldIdSchema,
  direction: z.enum(Object.values(ListSortDirection)),
} satisfies Record<keyof ListSortRule, z.ZodTypeAny>;

const isBetweenClauseSchema = z
  .object(isBetweenClauseShape)
  .strict()
  .superRefine((clause, ctx) => {
    if (clause.min === undefined && clause.max === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "isBetween needs a min, a max, or both",
      });
      return;
    }
    if (clause.min === undefined || clause.max === undefined) {
      return;
    }
    if (typeof clause.min !== typeof clause.max) {
      ctx.addIssue({
        code: "custom",
        message: "isBetween bounds must be the same scalar type",
      });
      return;
    }
    if (
      typeof clause.min === "number" &&
      typeof clause.max === "number" &&
      clause.min > clause.max
    ) {
      ctx.addIssue({ code: "custom", message: "isBetween min exceeds max" });
    }
  });

const filterClauseSchema = z.union([
  z.object(isAnyOfClauseShape).strict(),
  isBetweenClauseSchema,
  z.object(emptinessClauseShape).strict(),
]);

const listQueryExpressionShape = {
  version: z.literal(LIST_QUERY_EXPRESSION_VERSION),
  filters: z.array(filterClauseSchema).max(LIST_QUERY_MAX_CLAUSES).optional(),
  sorts: z
    .array(z.object(sortRuleShape).strict())
    .max(LIST_QUERY_MAX_SORT_RULES)
    .optional(),
} satisfies Record<keyof ListQueryExpression, z.ZodTypeAny>;

/**
 * Strict boundary validation for a v1 expression. Also enforces the two
 * one-per-field rules: a second clause on a field would make AND-across-clauses
 * ambiguous with OR-within-a-clause, and a second sort rule on a field would
 * order by it twice.
 *
 * It reports every rejection as a zod issue. A caller that needs the refusal
 * codes reads through {@link parseListQueryExpressionValue} instead.
 */
export const listQueryExpressionSchema: z.ZodType<ListQueryExpression> = z
  .object(listQueryExpressionShape)
  .strict()
  .superRefine((expression, ctx) => {
    addDuplicateFieldIssues(expression.filters, "filters", ctx);
    addDuplicateFieldIssues(expression.sorts, "sorts", ctx);
  });

export type ListQueryParseResult =
  | { ok: true; expression: ListQueryExpression }
  | { ok: false; refused: ListQueryRefused };

/**
 * Read one {@link LIST_QUERY_EXPRESSION_PARAM} value, or say why not: the
 * length cap and JSON decode, then {@link parseListQueryExpressionValue}. This
 * never throws.
 *
 * Read by the cloud list routes (Sessions ISS-9477, Branches PRD-721), which
 * receive the param in the query string.
 */
export function parseListQueryExpression(raw: string): ListQueryParseResult {
  if (raw.length > LIST_QUERY_EXPRESSION_MAX_LENGTH) {
    return refused(ListQueryRefusal.Malformed, {});
  }
  return parseListQueryExpressionValue(parseJson(raw));
}

/**
 * Read an expression that is already a structured value, or say why not.
 *
 * The specific refusals are checked BEFORE the strict schema so a caller learns
 * what to change: a newer client's version or operator is not "malformed", and
 * a cap is not a shape error. Everything the schema rejects after that is
 * {@link ListQueryRefusal.Malformed}. This never throws.
 *
 * Read by the desktop compilers (Sessions ISS-9479, Branches PRD-721), which
 * receive the expression as a structured IPC value.
 */
export function parseListQueryExpressionValue(
  json: unknown
): ListQueryParseResult {
  if (!recordProbe.safeParse(json).success) {
    return refused(ListQueryRefusal.Malformed, {});
  }
  const envelope = envelopeProbe.safeParse(json);
  if (!envelope.success) {
    return refused(ListQueryRefusal.Malformed, {});
  }
  const specificRefusal =
    refuseEnvelope(envelope.data) ?? refuseClauses(envelope.data.filters);
  if (specificRefusal) {
    return { ok: false, refused: specificRefusal };
  }
  // The strict schema reads the JSON exactly as parsed, never a probe's
  // output: a probe rebuilds the object, which turns an own `__proto__` key
  // into a prototype the strict key check cannot see.
  const parsed = listQueryExpressionSchema.safeParse(json);
  if (parsed.success) {
    return { ok: true, expression: parsed.data };
  }
  return refused(
    ListQueryRefusal.Malformed,
    malformedDetails(envelope.data, parsed.error.issues[0]?.path ?? [])
  );
}

/**
 * Loose probes over input the strict schema has not accepted yet. Each is a
 * gate or a reader for one specific refusal; anything it cannot read is left
 * for the strict schema to report as Malformed.
 */
const recordProbe = z.record(z.string(), z.unknown());
const envelopeProbe = z.looseObject({
  version: z.number(),
  filters: z.array(z.unknown()).optional().catch(undefined),
  sorts: z.array(z.unknown()).optional().catch(undefined),
});
const entryProbe = z.looseObject({
  field: z.string().optional().catch(undefined),
  operator: z.string().optional().catch(undefined),
  values: z.array(z.unknown()).optional().catch(undefined),
});
type EntryProbe = z.infer<typeof entryProbe>;

function refuseEnvelope(
  envelope: z.infer<typeof envelopeProbe>
): ListQueryRefused | null {
  if (envelope.version !== LIST_QUERY_EXPRESSION_VERSION) {
    return { code: ListQueryRefusal.UnsupportedVersion, details: {} };
  }
  if ((envelope.filters?.length ?? 0) > LIST_QUERY_MAX_CLAUSES) {
    return { code: ListQueryRefusal.TooManyClauses, details: {} };
  }
  if ((envelope.sorts?.length ?? 0) > LIST_QUERY_MAX_SORT_RULES) {
    return { code: ListQueryRefusal.TooManySortRules, details: {} };
  }
  return null;
}

/**
 * Every clause's operator is checked before any clause's value count, so a
 * newer client's operator is reported wherever it sits in the list. Only an
 * `isAnyOf` clause carries values; a `values` key on any other clause is a
 * shape error the strict schema reports as Malformed.
 */
function refuseClauses(
  filters: readonly unknown[] | undefined
): ListQueryRefused | null {
  const clauses = (filters ?? []).flatMap(probeEntry);
  const unknownOperator = clauses.find(
    (clause) =>
      clause.operator !== undefined && !isListFilterOperator(clause.operator)
  );
  if (unknownOperator) {
    return {
      code: ListQueryRefusal.UnsupportedOperator,
      details: detailsOf(unknownOperator),
    };
  }
  const overfull = clauses.find(
    (clause) =>
      clause.operator === ListFilterOperator.IsAnyOf &&
      (clause.values?.length ?? 0) > LIST_QUERY_MAX_VALUES_PER_CLAUSE
  );
  return overfull
    ? { code: ListQueryRefusal.TooManyValues, details: detailsOf(overfull) }
    : null;
}

/** Name the offending clause's field when the issue sits inside one. */
function malformedDetails(
  envelope: z.infer<typeof envelopeProbe>,
  path: readonly PropertyKey[]
): ListQueryRefusalDetails {
  const [collection, index] = path;
  if (
    (collection !== "filters" && collection !== "sorts") ||
    typeof index !== "number"
  ) {
    return {};
  }
  const [entry] = probeEntry(envelope[collection]?.[index]);
  return entry ? detailsOf(entry) : {};
}

function addDuplicateFieldIssues(
  entries: readonly { field: string }[] | undefined,
  collection: "filters" | "sorts",
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>();
  for (const [index, entry] of (entries ?? []).entries()) {
    if (seen.has(entry.field)) {
      ctx.addIssue({
        code: "custom",
        message: `${entry.field} appears more than once in ${collection}`,
        path: [collection, index],
      });
    }
    seen.add(entry.field);
  }
}

/** An absent field or operator is omitted from `details`, never `undefined`. */
function detailsOf({ field, operator }: EntryProbe): ListQueryRefusalDetails {
  return {
    ...(field === undefined ? {} : { field }),
    ...(operator === undefined ? {} : { operator }),
  };
}

function probeEntry(entry: unknown): EntryProbe[] {
  const probed = entryProbe.safeParse(entry);
  return probed.success ? [probed.data] : [];
}

const LIST_FILTER_OPERATORS = new Set<string>(
  Object.values(ListFilterOperator)
);

function isListFilterOperator(value: string): boolean {
  return LIST_FILTER_OPERATORS.has(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function refused(
  code: ListQueryRefusal,
  details: ListQueryRefusalDetails
): ListQueryParseResult {
  return { ok: false, refused: { code, details } };
}
