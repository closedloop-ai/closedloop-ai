import type {
  ListQueryCapability,
  ListQueryCapabilityResult,
} from "./list-query-capability.ts";
import { resolveListQueryCapability } from "./list-query-capability.ts";
import {
  LIST_QUERY_EXPRESSION_VERSION,
  type ListFilterClause,
  ListFilterOperator,
  type ListQueryExpression,
  type ListQueryRefused,
  ListSortDirection,
} from "./list-query-expression.ts";
import {
  parseListQueryExpression,
  parseListQueryExpressionValue,
} from "./list-query-expression-schema.ts";

/** An `isAnyOf` clause on `field` with `count` distinct placeholder values. */
export function anyOf(field: string, count = 1): ListFilterClause {
  return {
    field,
    operator: ListFilterOperator.IsAnyOf,
    values: Array.from({ length: count }, (_, index) => `v${index}`),
  };
}

/** A v1 expression with these clauses, sorted ascending by `sortFields` in order. */
export function expressionOf(
  filters: ListFilterClause[],
  sortFields: string[] = []
): ListQueryExpression {
  return {
    version: LIST_QUERY_EXPRESSION_VERSION,
    filters,
    sorts: sortFields.map((field) => ({
      field,
      direction: ListSortDirection.Asc,
    })),
  };
}

/** Raw param text for a v1 envelope carrying `filters` as given, shape unchecked. */
export function withFilters(filters: unknown[]): string {
  return JSON.stringify({ version: LIST_QUERY_EXPRESSION_VERSION, filters });
}

/** The parser's refusal for `raw`, or `null` when it parses. */
export function parseRefusal(raw: string): ListQueryRefused | null {
  const result = parseListQueryExpression(raw);
  return result.ok ? null : result.refused;
}

/** The structured-value parser's refusal for `value`, or `null` when it parses. */
export function valueRefusal(value: unknown): ListQueryRefused | null {
  const result = parseListQueryExpressionValue(value);
  return result.ok ? null : result.refused;
}

/** The resolver's refusal for `expression` on `capability`, or `null` when served. */
export function capabilityRefusal(
  expression: ListQueryExpression,
  capability: ListQueryCapability
): ListQueryRefused | null {
  const result: ListQueryCapabilityResult = resolveListQueryCapability(
    expression,
    capability
  );
  return result.ok ? null : result.refused;
}
