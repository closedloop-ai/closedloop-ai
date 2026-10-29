import { isRecord } from "@/lib/type-guards";

/**
 * A Prisma `where` evaluator over plain fixture rows, with Prisma's own
 * semantics: **an absent (or `undefined`) key constrains nothing**, so a fake
 * built on it is only as narrow as the predicate the service actually wrote.
 * That is what lets an org-scoping test go red when production drops its
 * `organizationId` (`apps/api/AGENTS.md` → Org scoping).
 *
 * It models only what it can model exactly and THROWS on anything else — an
 * unknown operator, or a fixture row missing a constrained column — so a clause
 * it silently ignored can never pass as narrowing.
 */
export type FixtureRow = Record<string, unknown>;

export function matchesWhere(row: FixtureRow, where: unknown): boolean {
  if (where === undefined) {
    return true;
  }
  if (!isRecord(where)) {
    throw new Error(`Unsupported where clause: ${String(where)}`);
  }
  return Object.entries(where).every(([key, condition]) =>
    matchesKey(row, key, condition)
  );
}

/** `findMany` with `orderBy: { id }`, `cursor` + `skip: 1`, and `take`. */
export function findManyRows(rows: readonly FixtureRow[], args: unknown) {
  const query = isRecord(args) ? args : {};
  const matched = rows
    .filter((row) => matchesWhere(row, query.where))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const cursor = isRecord(query.cursor) ? query.cursor.id : undefined;
  const start =
    cursor === undefined
      ? 0
      : matched.findIndex((row) => row.id === cursor) +
        (typeof query.skip === "number" ? query.skip : 0);
  const rest = matched.slice(start);
  return typeof query.take === "number" ? rest.slice(0, query.take) : rest;
}

function matchesKey(row: FixtureRow, key: string, condition: unknown) {
  if (condition === undefined) {
    return true;
  }
  if (key === "AND") {
    return asList(condition).every((clause) => matchesWhere(row, clause));
  }
  if (key === "OR") {
    return asList(condition).some((clause) => matchesWhere(row, clause));
  }
  if (key === "NOT") {
    return !asList(condition).some((clause) => matchesWhere(row, clause));
  }
  if (!(key in row)) {
    throw new Error(`Fixture row has no "${key}" to constrain`);
  }
  return matchesValue(row[key], condition);
}

function matchesValue(value: unknown, condition: unknown): boolean {
  if (condition === null) {
    return value === null;
  }
  if (Array.isArray(value)) {
    return matchesToMany(value, condition);
  }
  if (!isRecord(condition) || condition instanceof Date) {
    return sameScalar(value, condition);
  }
  if ("is" in condition || "isNot" in condition) {
    return matchesToOne(value, condition);
  }
  if (!Object.keys(condition).every((key) => SCALAR_OPERATORS.has(key))) {
    // The to-one shorthand (`project: { status: … }`): no related row, no match.
    return isRecord(value) && matchesWhere(value, condition);
  }
  return Object.entries(condition).every(([operator, operand]) =>
    matchesOperator(value, operator, operand)
  );
}

function matchesToMany(value: unknown[], condition: unknown): boolean {
  if (isRecord(condition) && "some" in condition) {
    return value.some(
      (item) => isRecord(item) && matchesWhere(item, condition.some)
    );
  }
  throw new Error(`Unsupported to-many filter: ${JSON.stringify(condition)}`);
}

function matchesToOne(value: unknown, condition: Record<string, unknown>) {
  if ("is" in condition) {
    return (
      value !== null &&
      isRecord(value) &&
      (condition.is === null || matchesWhere(value, condition.is))
    );
  }
  if (condition.isNot === null) {
    return value !== null;
  }
  return !(isRecord(value) && matchesWhere(value, condition.isNot));
}

function matchesOperator(
  value: unknown,
  operator: string,
  operand: unknown
): boolean {
  switch (operator) {
    case "in":
      return asList(operand).some((item) => sameScalar(value, item));
    case "notIn":
      return !asList(operand).some((item) => sameScalar(value, item));
    case "not":
      return !matchesValue(value, operand);
    case "equals":
      return sameScalar(value, operand);
    case "gte":
      return compare(value, operand) >= 0;
    case "lte":
      return compare(value, operand) <= 0;
    case "contains":
      return (
        typeof value === "string" &&
        typeof operand === "string" &&
        value.toLowerCase().includes(operand.toLowerCase())
      );
    case "mode":
      return true;
    default:
      throw new Error(`Unsupported operator "${operator}"`);
  }
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function sameScalar(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

function compare(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : Number(left);
  const b = right instanceof Date ? right.getTime() : Number(right);
  return a - b;
}

const SCALAR_OPERATORS = new Set([
  "in",
  "notIn",
  "not",
  "equals",
  "gte",
  "lte",
  "contains",
  "mode",
]);
