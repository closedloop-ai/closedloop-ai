/**
 * FEA-4112: the live-`schema.prisma` assertions this file used to carry are gone.
 *
 * AGENTS.md → Test Practices bans reading `prisma/schema.prisma` as text to
 * assert that a model has a given column, index, `@@unique` or `@@map` — a
 * "decision table pinned against the schema" is exactly the brittle source-text
 * pattern the source gate blocks. Schema shape is enforced by `prisma migrate` /
 * `prisma generate`, and proven behaviorally by the services that query these
 * tables.
 *
 * What remains is the per-migration `migration.sql` DDL contract guard, which
 * AGENTS.md explicitly keeps allowed and which pins the actually-shipped DDL:
 * the enum, the two new tables, the security-relevant columns (encrypted-only
 * tokens, the `scopes` default, the added `external_author_id`), every index the
 * migration creates — unique AND non-unique — every foreign key together with
 * its `ON DELETE` action, and the absent RENAME/MEMBER statements.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { APPROVER_ROLE_OPTIONS, ApproverRole } from "@repo/api/src/types/user";
import { ApproverRole as GeneratedApproverRole } from "@repo/database/generated/enums";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const migrationsDir = path.join(
  repoRoot,
  "packages/database/prisma/migrations"
);
const commentIdentityMigrationPattern = /add_github_comment_identity$/;
/**
 * A bare `access_token` / `refresh_token` COLUMN — encrypted-only is the
 * contract. Deliberately blind to the declared type: pinning `TEXT` let a later
 * `ADD COLUMN "access_token" VARCHAR(255)` ship the forbidden plaintext token
 * past this guard. `"access_token_encrypted"` does not match, because the
 * closing quote must follow `_token`.
 */
const plaintextTokenColumnPattern = /"(access|refresh)_token"/;
const STATEMENT_SEPARATOR = ";";
const CONNECTIONS_TABLE = '"github_user_connections"';
const USERS_TABLE = '"users"';
const ROLE_COLUMN = '"role"';
const memberRolePattern = /\bMEMBER\b/;
const renameConstraintPattern = /\bRENAME CONSTRAINT\b/;

describe("GitHub comment identity schema", () => {
  it("defines provider authors and GitHub user connections with scoped constraints", () => {
    const migrationSql = readMigrationSql(commentIdentityMigrationPattern);

    expect(migrationSql).toContain(
      "CREATE TYPE \"ExternalCommentProvider\" AS ENUM ('GITHUB')"
    );
    expect(migrationSql).toContain('CREATE TABLE "external_comment_authors"');
    expect(migrationSql).toContain('CREATE TABLE "github_user_connections"');
    expect(migrationSql).toContain(
      '"scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]'
    );
    expect(migrationSql).toContain(
      'ALTER TABLE "github_comment_projections" ADD COLUMN "external_author_id" UUID'
    );
    // OAuth tokens ship encrypted-only.
    expect(migrationSql).toContain('"access_token_encrypted" TEXT NOT NULL');
    expect(migrationSql).not.toMatch(renameConstraintPattern);
    expect(migrationSql).not.toMatch(memberRolePattern);
  });

  it("creates every index the migration ships, unique and non-unique", () => {
    const migrationSql = readMigrationSql(commentIdentityMigrationPattern);

    // Each expectation carries the whole `CREATE [UNIQUE] INDEX … ON …(cols)`
    // statement, so a dropped index, a renamed one, a changed column list, or a
    // unique/non-unique flip all fail here — a bare name check would not.
    for (const statement of commentIdentityIndexStatements) {
      expect(migrationSql).toContain(statement);
    }
  });

  it("pins the ON DELETE action on every foreign key the migration adds", () => {
    const migrationSql = readMigrationSql(commentIdentityMigrationPattern);

    // Per-statement, not a global `toContain("ON DELETE SET NULL")`: the
    // constraint name and its referential action are asserted as one contiguous
    // string, so one FK's action cannot satisfy another's.
    for (const statement of commentIdentityForeignKeyStatements) {
      expect(migrationSql).toContain(statement);
    }
  });

  it("keeps shadow user role compatible with the ApproverRole enum", () => {
    // The shadow users written by `apps/api/app/comments/external-authors.ts`
    // carry `ApproverRole.Engineer`, and the shipped `users.role` DDL is that
    // same enum and default — so the canonical const and the column cannot
    // drift apart. `MEMBER` belongs to TeamRole and is not an ApproverRole.
    //
    // Derived across EVERY migration, not read out of the creating one: a later
    // `ALTER COLUMN "role" SET DEFAULT …` would change the live schema while a
    // create-table-only assertion stayed green.
    expect(currentUsersRoleDdl()).toContain(
      `${ROLE_COLUMN} "ApproverRole" NOT NULL DEFAULT '${ApproverRole.Engineer}'`
    );
    // Membership is asserted through the GENERATED Prisma enum — the sanctioned
    // runtime boundary — so adding `MEMBER` to the database type fails here too,
    // and the canonical const cannot drift from it.
    expect(APPROVER_ROLE_OPTIONS).toEqual(Object.values(GeneratedApproverRole));
    expect(APPROVER_ROLE_OPTIONS).not.toContain("MEMBER");
  });
  it("keeps github_user_connections encrypted-only across EVERY migration", () => {
    // Scanning only the creating migration would let a LATER one add a
    // plaintext token column without tripping this guard. The migration
    // directory is append-only and immutable, so the union of every
    // migration.sql IS the current schema — that makes this a current-state
    // assertion, not a point-in-time one. (Reading migration.sql as text is the
    // sanctioned mechanism; reading the live schema.prisma is not.)
    const offenders = readdirSync(migrationsDir)
      .filter((name) => hasPlaintextTokenColumn(readMigrationSqlByName(name)))
      .sort();

    expect(offenders).toEqual([]);
    // Non-vacuity: the walk must actually be reading migrations.
    expect(readdirSync(migrationsDir).length).toBeGreaterThan(0);
  });

  it("flags a plaintext token column whatever type it declares", () => {
    // The mutation the guard must survive: a later migration adding the
    // forbidden column as VARCHAR rather than TEXT.
    const plaintext = `ALTER TABLE ${CONNECTIONS_TABLE} ADD COLUMN "access_token" VARCHAR(255)${STATEMENT_SEPARATOR}`;
    const encrypted = `ALTER TABLE ${CONNECTIONS_TABLE} ADD COLUMN "access_token_encrypted" TEXT NOT NULL${STATEMENT_SEPARATOR}`;

    expect(hasPlaintextTokenColumn(plaintext)).toBe(true);
    expect(hasPlaintextTokenColumn(encrypted)).toBe(false);
  });
});

/**
 * The statements in `sql` that touch `github_user_connections`.
 *
 * Scoped per statement on purpose: other tables legitimately carry
 * `access_token` columns, so a whole-file match would flag unrelated
 * migrations (the Google integration one, for instance).
 */
function connectionsStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_SEPARATOR)
    .filter((statement) => statement.includes(CONNECTIONS_TABLE));
}

function readMigrationSqlByName(migrationName: string): string {
  const sqlPath = path.join(migrationsDir, migrationName, "migration.sql");
  return existsSync(sqlPath) ? readFileSync(sqlPath, "utf8") : "";
}

function readMigrationSql(namePattern: RegExp): string {
  const migrationName = readdirSync(migrationsDir).find((entry) =>
    namePattern.test(entry)
  );
  if (!migrationName) {
    throw new Error(`migration matching ${namePattern} missing`);
  }
  return readFileSync(
    path.join(migrationsDir, migrationName, "migration.sql"),
    "utf8"
  );
}

/** Every index `20260520064305_add_github_comment_identity` creates, verbatim. */
const commentIdentityIndexStatements = [
  'CREATE INDEX "external_comment_authors_organization_id_provider_normalize_idx" ON "external_comment_authors"("organization_id", "provider", "normalized_provider_login")',
  'CREATE INDEX "external_comment_authors_user_id_idx" ON "external_comment_authors"("user_id")',
  'CREATE INDEX "github_pr_review_comments_external_author_id_idx" ON "github_pr_review_comments"("external_author_id")',
  'CREATE INDEX "github_comment_projections_external_author_id_idx" ON "github_comment_projections"("external_author_id")',
  'CREATE INDEX "github_user_connections_organization_id_normalized_login_idx" ON "github_user_connections"("organization_id", "normalized_login")',
  'CREATE INDEX "github_user_connections_revoked_at_idx" ON "github_user_connections"("revoked_at")',
  'CREATE UNIQUE INDEX "external_comment_authors_organization_id_provider_provider__key" ON "external_comment_authors"("organization_id", "provider", "provider_user_id")',
  'CREATE UNIQUE INDEX "github_user_connections_organization_id_user_id_key" ON "github_user_connections"("organization_id", "user_id")',
  'CREATE UNIQUE INDEX "github_user_connections_organization_id_github_user_id_key" ON "github_user_connections"("organization_id", "github_user_id")',
] as const;

/**
 * Every foreign key the same migration adds, verbatim — including the `ON
 * DELETE` action. Org/user ownership CASCADEs (the identity row dies with its
 * org or user); a comment's `external_author_id` is SET NULL, so deleting an
 * author never deletes the projected comment.
 */
const commentIdentityForeignKeyStatements = [
  'ALTER TABLE "external_comment_authors" ADD CONSTRAINT "external_comment_authors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE',
  'ALTER TABLE "external_comment_authors" ADD CONSTRAINT "external_comment_authors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE',
  'ALTER TABLE "github_pr_review_comments" ADD CONSTRAINT "github_pr_review_comments_external_author_id_fkey" FOREIGN KEY ("external_author_id") REFERENCES "external_comment_authors"("id") ON DELETE SET NULL ON UPDATE CASCADE',
  'ALTER TABLE "github_comment_projections" ADD CONSTRAINT "github_comment_projections_external_author_id_fkey" FOREIGN KEY ("external_author_id") REFERENCES "external_comment_authors"("id") ON DELETE SET NULL ON UPDATE CASCADE',
  'ALTER TABLE "github_user_connections" ADD CONSTRAINT "github_user_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE',
  'ALTER TABLE "github_user_connections" ADD CONSTRAINT "github_user_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE',
] as const;

/** Does any `github_user_connections` statement in `sql` add a plaintext token? */
function hasPlaintextTokenColumn(sql: string): boolean {
  return connectionsStatements(sql).some((statement) =>
    plaintextTokenColumnPattern.test(statement)
  );
}

/**
 * The CURRENT `users.role` DDL: the LAST statement across every migration, in
 * timestamp order, that names both the table and the column. The migration
 * directory is append-only and immutable, so that union IS the live schema —
 * which makes this a current-state assertion, not a point-in-time one.
 */
function currentUsersRoleDdl(): string | undefined {
  const defining: string[] = [];
  for (const migration of readdirSync(migrationsDir).sort()) {
    for (const statement of readMigrationSqlByName(migration).split(
      STATEMENT_SEPARATOR
    )) {
      if (statement.includes(USERS_TABLE) && statement.includes(ROLE_COLUMN)) {
        defining.push(statement);
      }
    }
  }
  return defining.at(-1);
}
