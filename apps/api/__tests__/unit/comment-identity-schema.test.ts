import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readModelBlock } from "./comment-schema-test-utils";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const migrationsDir = path.join(
  repoRoot,
  "packages/database/prisma/migrations"
);
const schemaPath = path.join(
  repoRoot,
  "packages/database/prisma/schema.prisma"
);
const migrationNamePattern = /add_github_comment_identity$/;
const plaintextAccessTokenFieldPattern = /\baccessToken\s+String\b/;
const plaintextRefreshTokenFieldPattern = /\brefreshToken\s+String\b/;
const memberRolePattern = /\bMEMBER\b/;
const approverRoleMemberPattern = /ApproverRole.*MEMBER/;
const renameConstraintPattern = /\bRENAME CONSTRAINT\b/;

describe("GitHub comment identity schema", () => {
  it("defines provider authors and GitHub user connections with scoped constraints", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const migrationSql = readTargetMigrationSql();

    expect(readEnumBlock(schema, "ExternalCommentProvider")).toContain(
      "GITHUB"
    );
    expect(readModelBlock(schema, "Organization")).toContain(
      "externalCommentAuthors"
    );
    expect(readModelBlock(schema, "Organization")).toContain(
      "githubUserConnections"
    );
    expect(readModelBlock(schema, "User")).toContain("externalCommentAuthors");
    expect(readModelBlock(schema, "User")).toContain("githubUserConnections");

    const authorModel = readModelBlock(schema, "ExternalCommentAuthor");
    expect(authorModel).toContain('@@map("external_comment_authors")');
    expect(authorModel).toContain(
      "@@unique([organizationId, provider, providerUserId])"
    );
    expect(authorModel).toContain(
      "@@index([organizationId, provider, normalizedProviderLogin])"
    );
    expect(authorModel).toContain("githubCommentProjections");
    expect(authorModel).toContain(
      "@relation(fields: [organizationId], references: [id], onDelete: Cascade)"
    );
    expect(authorModel).toContain(
      "@relation(fields: [userId], references: [id], onDelete: Cascade)"
    );

    const connectionModel = readModelBlock(schema, "GitHubUserConnection");
    expect(connectionModel).toContain('@@map("github_user_connections")');
    expect(connectionModel).toContain("@@unique([organizationId, userId])");
    expect(connectionModel).toContain(
      "@@unique([organizationId, githubUserId])"
    );
    expect(connectionModel).toContain("@@index([revokedAt])");
    expect(connectionModel).toContain(
      'accessTokenEncrypted  String    @map("access_token_encrypted") @db.Text'
    );
    expect(connectionModel).toContain(
      "scopes                String[]  @default([])"
    );
    expect(connectionModel).not.toMatch(plaintextAccessTokenFieldPattern);
    expect(connectionModel).not.toMatch(plaintextRefreshTokenFieldPattern);

    const githubCommentProjectionModel = readModelBlock(
      schema,
      "GitHubCommentProjection"
    );
    expect(githubCommentProjectionModel).toContain(
      'externalAuthorId         String?   @map("external_author_id") @db.Uuid'
    );
    expect(githubCommentProjectionModel).toContain(
      "ExternalCommentAuthor?        @relation(fields: [externalAuthorId], references: [id], onDelete: SetNull)"
    );
    expect(githubCommentProjectionModel).toContain(
      '@@index([externalAuthorId], map: "github_comment_projections_external_author_id_idx")'
    );

    expect(migrationSql).toContain(
      'CREATE TYPE "ExternalCommentProvider" AS ENUM'
    );
    expect(migrationSql).toContain('CREATE TABLE "external_comment_authors"');
    expect(migrationSql).toContain('CREATE TABLE "github_user_connections"');
    expect(migrationSql).toContain(
      '"scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]'
    );
    expect(migrationSql).toContain(
      'ALTER TABLE "github_comment_projections" ADD COLUMN "external_author_id" UUID'
    );
    expect(migrationSql).toContain(
      'CREATE INDEX "github_comment_projections_external_author_id_idx"'
    );
    expect(migrationSql).toContain(
      'ADD CONSTRAINT "github_comment_projections_external_author_id_fkey"'
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "github_user_connections_organization_id_user_id_key"'
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "github_user_connections_organization_id_github_user_id_key"'
    );
    expect(migrationSql).not.toMatch(renameConstraintPattern);
    expect(migrationSql).not.toMatch(memberRolePattern);
  });

  it("keeps shadow user role compatible with the ApproverRole enum", () => {
    const schema = readFileSync(schemaPath, "utf8");

    expect(readEnumBlock(schema, "ApproverRole")).toContain("ENGINEER");
    expect(readModelBlock(schema, "User")).toContain(
      "role                     ApproverRole          @default(ENGINEER)"
    );
    expect(readModelBlock(schema, "User")).not.toMatch(
      approverRoleMemberPattern
    );
  });
});

function readTargetMigrationSql(): string {
  return readFileSync(
    path.join(migrationsDir, readTargetMigrationName(), "migration.sql"),
    "utf8"
  );
}

function readTargetMigrationName(): string {
  const migrationName = readdirSync(migrationsDir).find((entry) =>
    migrationNamePattern.test(entry)
  );
  if (!migrationName) {
    throw new Error("add_github_comment_identity migration missing");
  }
  return migrationName;
}

function readEnumBlock(schema: string, enumName: string): string {
  const enumStart = schema.indexOf(`enum ${enumName} {`);
  const enumEnd = schema.indexOf("\n}", enumStart);

  if (enumStart === -1 || enumEnd === -1) {
    throw new Error(`enum block missing for ${enumName}`);
  }

  return schema.slice(enumStart, enumEnd + 2);
}
