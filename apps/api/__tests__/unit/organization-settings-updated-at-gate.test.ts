import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

/**
 * ISS-7157 — no raw `UPDATE "organizations"` statement may omit `updated_at`.
 *
 * `Organization.updatedAt` is declared `@updatedAt`, but Prisma applies that at
 * the CLIENT layer: there is no database default and no trigger behind the
 * column. Every `Organization.settings` write was moved off Prisma's `update`
 * onto a raw `jsonb_set` UPDATE (ISS-7092, ISS-7111, ISS-7119, ISS-7121), and
 * all four of the resulting statements silently stopped maintaining it.
 *
 * WHY A SOURCE GATE AND NOT ONLY THE DB-BACKED SUITE. The integration suite
 * (`__tests__/integration/iss7157-organization-settings-updated-at`) proves the
 * four writers that exist today really move the column, which no static check
 * can. What it cannot do is cover the FIFTH writer: it enumerates its subjects
 * by hand, so a statement added tomorrow is outside it by construction, and
 * three of the four statement shapes live in caller files rather than in the
 * shared writer. This gate is the half that scales — it finds the statement
 * wherever it is written.
 *
 * WHY THE AST AND NOT A GREP. `AGENTS.md` bans asserting on raw source text:
 * it breaks on renames and is satisfiable by a neighbouring string or comment.
 * The statements here are read as literal nodes — template literals for the
 * `Prisma.sql`/`$executeRaw` tags, and plain string literals for the
 * `$executeRawUnsafe`/`$queryRawUnsafe` shape this package also uses — so only
 * SQL a driver will actually send is judged. SQL comments are stripped BEFORE
 * anything is classified, so a statement is neither found nor judged by text
 * that Postgres never parses, and the clause must be an ASSIGNMENT, so neither
 * `-- set updated_at here` nor a bare mention of the column can stand in.
 *
 * WHAT IT DOES NOT COVER, stated rather than implied. A statement whose table
 * name is itself interpolated has no static table name to match on, and no
 * source gate can see it. Neither can this one see a writer OUTSIDE the
 * `apps/api` package — it walks that package and stops at its boundary, because
 * a suite that reads across package roots would be asserting on code it does
 * not own. That gap is empty today (a repo-wide search finds raw
 * `UPDATE "organizations"` statements only under `apps/api`, and
 * `packages/database` reaches the table through the Prisma client, which
 * applies `@updatedAt` itself), and it is the boundary to revisit if a raw
 * settings writer is ever added elsewhere. The DB-backed suite is the half that
 * covers behaviour; this is the half that covers reach.
 */

/**
 * Anchored to this file, not `process.cwd()`: `apps/api` is a ROOT_SANDBOX
 * package, so a mutation run spawns vitest at the repo root and a cwd-relative
 * root would scan a directory that does not exist there.
 */
const API_ROOT = join(import.meta.dirname, "..", "..");

/**
 * Directories that cannot hold a production module. The scan starts at the
 * PACKAGE ROOT and skips these, rather than naming the directories to visit: a
 * gate whose reach is an allow-list silently stops covering the next directory
 * someone adds, which is the failure mode it exists to prevent. Root-level
 * modules (`proxy.ts`, `instrumentation.node.ts`, and friends) are in reach for
 * the same reason.
 */
const UNSCANNED_DIRECTORIES = new Set([
  "node_modules",
  "__tests__",
  ".next",
  ".turbo",
  "generated",
]);

/**
 * An update against the table, in either identifier spelling and in any case —
 * Postgres does not care, so neither can a gate that claims to find every one.
 * The optional `ONLY` and schema qualifier are matched for the same reason:
 * `UPDATE ONLY public."organizations"` is the same write, and a gate that reads
 * it as a different one passes vacuously on the writer it was meant to judge.
 */
const ORGANIZATIONS_UPDATE =
  /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?organizations"?\b/i;

/**
 * Narrows which files are worth parsing. Deliberately far looser than the AST
 * match: any statement naming the table statically contains this token, so the
 * filter can drop only files that could never have matched anyway.
 */
const MENTIONS_TABLE = /organizations/i;

/**
 * The column ASSIGNED, in either spelling Postgres accepts and with the value
 * either inlined or bound (a bound value leaves the `=` as the last static text
 * before the interpolation). Requiring the `=` is what stops a mention in a
 * comment or a `RETURNING` list from satisfying the gate. Word bounded so a
 * longer column that merely ends in it cannot stand in.
 */
const ASSIGNS_UPDATED_AT = /"?\bupdated_at\b"?\s*=/;

/**
 * The assignment must go THROUGH `GREATEST`, reading the column on the row the
 * transaction has already locked. Assignment alone is not the invariant: a
 * writer spelled `SET "settings" = …, "updated_at" = ${new Date()}` satisfies
 * `ASSIGNS_UPDATED_AT` while binding a value captured before the statement
 * waited on anything, so a delayed write moves the column BACKWARDS past a
 * stamp already committed. That is the same "settings changed, `updated_at`
 * says otherwise" silence the omission produces, reached from the other side,
 * and a gate that goes green on it covers only the half that is easy to see.
 *
 * Matched in the SET region on the same terms as the assignment above, so a
 * `GREATEST` in the predicate or in a trailing comment cannot stand in for one
 * in the write.
 */
const GREATEST_UPDATED_AT = /\bGREATEST\s*\(\s*"?\bupdated_at\b"?/i;

/**
 * Splits the SET list off from the predicate. The `=` test alone is not enough:
 * a writer doing optimistic concurrency (`WHERE "id" = … AND "updated_at" = …`)
 * satisfies it while assigning nothing, which is the same green-on-a-broken-
 * writer this gate exists to prevent.
 *
 * The FIRST `WHERE` is the cut, mirroring `renderedWhereClause`. A subquery
 * carrying its own `WHERE` ahead of the real one would truncate the SET region
 * early and hide a real assignment — a FALSE RED, which is the safe direction.
 * Do not "fix" that by cutting at the last `WHERE`: that trades a false failure
 * for a false pass.
 */
const BEFORE_WHERE = /^[\s\S]*?(?=\bWHERE\b|$)/i;

/** Line and block comments, which are not clauses. */
const SQL_COMMENTS = /--[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Suites and fixtures are excluded: a test may legitimately build a probe
 * statement in whatever shape it is probing, and this gate is about the
 * statements that reach production.
 */
function isProductionModule(fileName: string): boolean {
  return (
    fileName.endsWith(".ts") &&
    !(fileName.endsWith(".test.ts") || fileName.endsWith(".d.ts"))
  );
}

function collectModules(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!UNSCANNED_DIRECTORIES.has(entry.name)) {
        found.push(...collectModules(path));
      }
    } else if (isProductionModule(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * The static text of every string-ish literal in the module — the SQL a driver
 * will send, with the interpolated values left out. Values are deliberately
 * dropped: a bound settings payload can contain anything, and one that happened
 * to carry the column name must not satisfy this gate.
 *
 * PLAIN STRING LITERALS are collected alongside templates because
 * `$executeRawUnsafe`/`$queryRawUnsafe` take one (`persist-session-children`
 * writes its monotonic timestamp that way), so a gate that read only templates
 * would go green on a writer in the shape most likely to be hand-rolled. They
 * cost nothing to add: a literal that is not SQL cannot match the table regex.
 */
function staticStatementTexts(sourceFile: ts.SourceFile): string[] {
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      texts.push(
        node.head.text +
          node.templateSpans.map((span) => span.literal.text).join(" ")
      );
    } else if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isStringLiteral(node)
    ) {
      texts.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return texts;
}

type OrganizationUpdate = {
  readonly module: string;
  readonly statement: string;
};

function findOrganizationUpdates(): OrganizationUpdate[] {
  const updates: OrganizationUpdate[] = [];
  for (const path of collectModules(API_ROOT)) {
    const source = readFileSync(path, "utf8");
    if (!MENTIONS_TABLE.test(source)) {
      continue;
    }
    const parsed = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true
    );
    for (const literal of staticStatementTexts(parsed)) {
      // Stripped BEFORE the table match, not after: a statement whose only
      // `UPDATE "organizations"` mention sits in a `-- ` comment is not a
      // writer, and classifying it as one fails it on an assignment it was
      // never supposed to carry.
      const statement = literal.replace(SQL_COMMENTS, " ");
      if (ORGANIZATIONS_UPDATE.test(statement)) {
        updates.push({
          module: path.slice(API_ROOT.length + 1),
          statement,
        });
      }
    }
  }
  return updates;
}

/** The writers that exist today. Not a ceiling — see the subset check below. */
const KNOWN_WRITERS = [
  "app/onboarding/service.ts",
  "app/settings/frustration-setting-service.ts",
  "lib/organization-settings-write.ts",
] as const;

describe('raw UPDATE "organizations" statements set updated_at (ISS-7157)', () => {
  const updates = findOrganizationUpdates();

  // Without this the gate passes loudest when it is most broken: a walker that
  // stops matching (a renamed table, a tag that stops being a template) finds
  // zero statements and every per-statement assertion below vacuously holds.
  //
  // A SUBSET check, not an equality: a fifth writer that complies is the
  // outcome this gate is for, and failing on it would make the file that
  // scales the one that has to be edited every time. A known writer that
  // DISAPPEARS from the set still fails — either the walker broke or the module
  // moved, and both are worth being told about rather than silently losing the
  // anchor.
  it("finds the raw organization updates it exists to judge", () => {
    const modules = new Set(updates.map((update) => update.module));
    expect(KNOWN_WRITERS.filter((module) => !modules.has(module))).toEqual([]);
  });

  it("assigns updated_at in every one of them", () => {
    const omitting = updates.filter(
      (update) => !ASSIGNS_UPDATED_AT.test(setRegion(update))
    );
    expect(omitting.map((update) => update.module)).toEqual([]);
  });

  // Split from the assignment check rather than folded into it so the two
  // failures name different defects: one writer forgot the column, the other
  // can drive it backwards. Both are red, and a reader should not have to
  // diff the statement to learn which.
  it("raises updated_at through GREATEST in every one of them, so no writer can move it backwards", () => {
    const unguarded = updates.filter(
      (update) => !GREATEST_UPDATED_AT.test(setRegion(update))
    );
    expect(unguarded.map((update) => update.module)).toEqual([]);
  });
});

/** The SET list, with the predicate cut off — see `BEFORE_WHERE`. */
function setRegion(update: OrganizationUpdate): string {
  return BEFORE_WHERE.exec(update.statement)?.[0] ?? "";
}
