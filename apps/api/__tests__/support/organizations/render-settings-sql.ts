/**
 * ISS-7148: the one renderer for a captured `Organization.settings` write.
 *
 * The settings-race suites (`onboarding-service`, `compute-mode-service`,
 * `github/backfill-service`) each assert that an atomic `jsonb_set` UPDATE is
 * scoped to exactly one organization. Doing that requires reconstructing the
 * statement with each bound value inlined at its own placeholder, because
 * asserting the SQL text and the value array SEPARATELY cannot tie a clause to
 * the parameter bound into it: a mutation that widens `WHERE "id" = ?::uuid`
 * while leaving the org id bound elsewhere in the statement keeps both separate
 * assertions green.
 *
 * Each suite grew its own copy of this pair and the copies diverged. This
 * module is the single definition; the copies are gone.
 */

const WHERE_CLAUSE_PATTERN = /\bWHERE\b([\s\S]*)$/;

export type RenderedSqlStatement = {
  /**
   * The tag's static segments, when the capturing stub preserved them. Exact by
   * construction — one more segment than values, with no parsing involved — so
   * it is preferred over splitting `text` whenever a caller has it.
   */
  readonly strings?: readonly string[];
  /**
   * The statement text with one `?` per bound value. The only shape available
   * to a stub that flattens nested `Sql` fragments, which loses the segment
   * array.
   */
  readonly text: string;
  /** The bound values, positionally aligned with the placeholders. */
  readonly values: readonly unknown[];
};

/**
 * The statement with every bound value inlined at its own placeholder.
 *
 * Throws rather than rendering a misaligned statement when the placeholder
 * count and the value count disagree. That guard is load-bearing on the `text`
 * path: splitting on `?` assumes every `?` is a binding, but Postgres also
 * spells its jsonb key-exists operators `?`, `?|`, and `?&`. One of those
 * entering the statement shifts every value one slot to the right and renders a
 * predicate nobody wrote — which a `toBe` on the whole WHERE clause would
 * report as a scoping regression that does not exist, or worse, would let a
 * real one through. Failing loudly is the only honest answer, and the caller's
 * fix is to capture `strings` rather than to loosen the assertion.
 *
 * The `strings` path cannot misalign the same way, but is guarded too so a
 * hand-built statement cannot silently drop or duplicate a value.
 */
export function renderSql(statement: RenderedSqlStatement): string {
  const segments = statement.strings ?? statement.text.split("?");
  if (segments.length - 1 !== statement.values.length) {
    throw new Error(
      `cannot render: ${segments.length - 1} placeholders for ${statement.values.length} values`
    );
  }
  return segments.reduce(
    (rendered, segment, index) =>
      index === 0
        ? segment
        : `${rendered}${JSON.stringify(statement.values[index - 1])}${segment}`,
    ""
  );
}

/**
 * The statement's ENTIRE predicate, values inlined — not a substring of it.
 *
 * Asserting the rendered statement merely CONTAINS `WHERE "id" = …` is a false
 * green: it rejects a widening that REPLACES the equality
 * (`WHERE "id" IS NOT NULL`) but not one that ADDS to it (`… ::uuid OR TRUE`),
 * and the additive form is the dangerous one — it keeps the equality clause
 * intact as a prefix while rewriting every organization's row. Comparing the
 * whole clause for equality rejects both.
 *
 * Returns `""` when the statement has no `WHERE` at all, and when no such write
 * was captured. Both fail every equality assertion a caller makes against this,
 * so an absent write can never read as a correctly-scoped one.
 *
 * The clause is found by first `\bWHERE\b` in the RENDERED text, so a bound
 * value that itself contains that token is captured as part of the clause. That
 * direction is deliberate and safe: the result is a strict superset of the real
 * predicate, so the caller's equality assertion fails RED. It can never report a
 * widened predicate as correctly scoped. Do not "fix" this by taking the LAST
 * match — that trades a false failure for a false pass.
 */
export function renderedWhereClause(
  statement: RenderedSqlStatement | undefined
): string {
  if (!statement) {
    return "";
  }
  return (WHERE_CLAUSE_PATTERN.exec(renderSql(statement))?.[1] ?? "").trim();
}
