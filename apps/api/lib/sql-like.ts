/**
 * ISS-6757: escape a value so a SQL `LIKE`/`ILIKE` pattern treats it literally.
 *
 * Postgres's default escape character for `LIKE`/`ILIKE` is the backslash, and
 * `%`, `_` and `\` are the only characters a pattern treats specially. Escaping
 * those three is what turns a bound value back into a literal, and two callers
 * need it for different reasons:
 *
 *  - a raw `ILIKE … ESCAPE '\'` CONTAINS search (`toSqlContainsPattern` in
 *    app/branches/branch-candidate-read.ts), where a user-typed `_` would
 *    otherwise quietly match any character;
 *  - Prisma's `equals` + `mode: "insensitive"`, which compiles to a bare
 *    `ILIKE $n` with NO `ESCAPE` clause. That predicate READS as
 *    case-insensitive equality, so a component key like `mcp__closedloop__ping`
 *    silently also matching `mcpXXclosedloopYYping` is a bug, not a feature.
 *
 * Shared rather than duplicated because the two spellings must not drift: an
 * escape set that grows here has to grow for both.
 */
const SQL_LIKE_ESCAPE_PATTERN = /[%_\\]/g;

export function escapeSqlLikeLiteral(value: string): string {
  return value.replace(SQL_LIKE_ESCAPE_PATTERN, "\\$&");
}

/**
 * A `LIKE`/`ILIKE` CONTAINS pattern for `value`, with its pattern characters
 * neutralized by {@link escapeSqlLikeLiteral}.
 *
 * Promoted here from `app/branches/branch-candidate-read.ts` when the
 * assigned-tree search (ISS-10472) became the second raw-SQL caller: the escape
 * set must not be duplicated, and neither must the wrapping. Callers pair it
 * with an explicit `ESCAPE` clause, since a bare `ILIKE $n` has none.
 */
export function toSqlContainsPattern(value: string): string {
  return `%${escapeSqlLikeLiteral(value)}%`;
}
