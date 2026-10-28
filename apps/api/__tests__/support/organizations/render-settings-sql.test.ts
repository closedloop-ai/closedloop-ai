import { describe, expect, it } from "vitest";
import {
  renderedWhereClause,
  renderSql,
} from "@/__tests__/support/organizations/render-settings-sql";

const THREE_FOR_TWO_PATTERN = /3 placeholders for 2 values/;
const TWO_FOR_ONE_PATTERN = /2 placeholders for 1 values/;
const ONE_FOR_TWO_PATTERN = /1 placeholders for 2 values/;

/**
 * ISS-7148. The cases that matter here are the ones the three duplicate copies
 * of this helper did NOT agree on. A test that only renders a simple statement
 * proves nothing: every copy did that correctly, which is precisely why they
 * diverged unnoticed for three tickets.
 */
describe("renderSql", () => {
  it("inlines each bound value at its own placeholder", () => {
    expect(
      renderSql({
        text: 'UPDATE "organizations" SET "settings" = ? WHERE "id" = ?::uuid',
        values: ["{}", "org-1"],
      })
    ).toBe(
      'UPDATE "organizations" SET "settings" = "{}" WHERE "id" = "org-1"::uuid'
    );
  });

  /**
   * THE discriminating case. `?` is both the binding placeholder and Postgres's
   * jsonb key-exists operator, so a statement carrying `settings ? 'key'` has
   * more `?` than values. Without the guard the reduce shifts every value one
   * slot right and emits a predicate nobody wrote — here the org id would land
   * inside the jsonb operand and the `WHERE "id" =` comparison would render
   * against a trailing empty segment. Throwing is the only honest answer.
   */
  it("throws rather than misaligning a statement whose text carries a jsonb key-exists operator", () => {
    expect(() =>
      renderSql({
        text: 'UPDATE "organizations" SET "settings" = ? WHERE "settings" ? \'computeMode\' AND "id" = ?::uuid',
        values: ["{}", "org-1"],
      })
    ).toThrow(THREE_FOR_TWO_PATTERN);
  });

  it.each([
    ["?|", 'WHERE "settings" ?| array[\'a\'] AND "id" = ?::uuid'],
    ["?&", 'WHERE "settings" ?& array[\'a\'] AND "id" = ?::uuid'],
  ])("throws on the jsonb %s operator too", (_operator, text) => {
    expect(() => renderSql({ text, values: ["org-1"] })).toThrow(
      TWO_FOR_ONE_PATTERN
    );
  });

  /**
   * The escape hatch the guard's message points at: a stub that preserves the
   * tag's static segments needs no `?`-splitting, so the same jsonb operator
   * renders exactly. Pinned so a future simplification that drops the `strings`
   * path has to fail this rather than quietly turn a renderable statement into
   * a thrown error.
   */
  it("renders a jsonb key-exists operator exactly when the caller preserved the static segments", () => {
    expect(
      renderSql({
        strings: [
          'UPDATE "organizations" SET "settings" = ',
          ' WHERE "settings" ? \'computeMode\' AND "id" = ',
          "::uuid",
        ],
        text: "unused when strings are present",
        values: ["{}", "org-1"],
      })
    ).toBe(
      'UPDATE "organizations" SET "settings" = "{}" WHERE "settings" ? \'computeMode\' AND "id" = "org-1"::uuid'
    );
  });

  it("guards the static-segment path against a hand-built misalignment", () => {
    expect(() =>
      renderSql({
        strings: ['WHERE "id" = ', "::uuid"],
        text: 'WHERE "id" = ?::uuid',
        values: ["org-1", "org-2"],
      })
    ).toThrow(ONE_FOR_TWO_PATTERN);
  });
});

describe("renderedWhereClause", () => {
  it("returns the whole predicate, not a prefix of it", () => {
    expect(
      renderedWhereClause({
        text: 'UPDATE "organizations" SET "settings" = ? WHERE "id" = ?::uuid',
        values: ["{}", "org-1"],
      })
    ).toBe('"id" = "org-1"::uuid');
  });

  /**
   * The additive widening the whole helper exists to catch: a `toContain` on
   * `"id" = "org-1"::uuid` passes here, because the correct clause survives as
   * a prefix while `OR TRUE` rewrites every other organization's row.
   */
  it("distinguishes an additively widened predicate from the scoped one", () => {
    expect(
      renderedWhereClause({
        text: 'UPDATE "organizations" SET "settings" = ? WHERE "id" = ?::uuid OR TRUE',
        values: ["{}", "org-1"],
      })
    ).not.toBe('"id" = "org-1"::uuid');
  });

  it.each([
    [
      "a statement with no WHERE at all",
      { text: 'UPDATE "organizations" SET "settings" = ?', values: ["{}"] },
    ],
    ["an uncaptured write", undefined],
  ])("returns an empty clause for %s", (_case, statement) => {
    expect(renderedWhereClause(statement)).toBe("");
  });

  /**
   * The clause is located by the FIRST `\bWHERE\b` in the rendered text, so a
   * bound value carrying that token is swept into the clause. Pinned because the
   * direction matters: the result is a strict SUPERSET of the real predicate, so
   * the caller's equality assertion fails red rather than passing on a predicate
   * it never checked. A future change that anchored on the last match instead
   * would trade this false failure for a false pass, and must fail here first.
   */
  it("fails safe when a bound value carries the WHERE token", () => {
    const clause = renderedWhereClause({
      text: 'UPDATE "organizations" SET "settings" = ? WHERE "id" = ?::uuid',
      values: ['{"note":"WHERE clause"}', "org-1"],
    });

    expect(clause).not.toBe('"id" = "org-1"::uuid');
    expect(clause).toContain('"id" = "org-1"::uuid');
  });
});
