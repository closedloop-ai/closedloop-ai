import { describe, expect, it } from "vitest";
import {
  MAX_IDENTIFIER_LENGTH,
  migrationDdl,
  parseForeignKeys,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

const MIGRATION_NAME = "20260911120000_iss9448_grid_preferences";
const TABLE = "grid_preferences";
const IDENTITY_KEY = "grid_preferences_identity_key";
const USER_INDEX = "grid_preferences_user_id_idx";
const ORGANIZATION_FOREIGN_KEY = "grid_preferences_organization_id_fkey";
const USER_FOREIGN_KEY = "grid_preferences_user_id_fkey";

const indexes = () => scanCreateIndexStatements(MIGRATION_NAME);
const foreignKeys = () => parseForeignKeys(MIGRATION_NAME);
const CREATE_GRID_PREFERENCES_TABLE_RE =
  /CREATE TABLE "grid_preferences" \((?<body>[\s\S]*?)\n\);/;
const TRAILING_COMMA_RE = /,$/;

describe(`${MIGRATION_NAME} index DDL`, () => {
  it("creates exactly the reviewed indexes", () => {
    expect(
      indexes()
        .map((index) => index.name)
        .sort()
    ).toEqual([IDENTITY_KEY, USER_INDEX].sort());
  });

  it("makes the authenticated selector unique", () => {
    const index = indexNamed(IDENTITY_KEY);

    expect(index.table).toBe(TABLE);
    expect(index.unique).toBe(true);
    expect(index.keys).toEqual([
      "organization_id",
      "user_id",
      "grid_key",
      "preference_kind",
      "scope_key",
    ]);
    expect(index.predicate).toBeNull();
  });

  it("keeps selector and user-cascade indexes plain but reviewed on the empty table", () => {
    for (const name of [IDENTITY_KEY, USER_INDEX]) {
      const index = indexNamed(name);

      expect(index.ifNotExists).toBe(true);
      expect(index.concurrently).toBe(false);
      expect(index.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
    }
    expect(indexNamed(USER_INDEX).keys).toEqual(["user_id"]);
  });
});

describe(`${MIGRATION_NAME} table DDL`, () => {
  it("stores reset tombstones without dropping the selector row", () => {
    expect(createTableColumns()).toContain('"deleted_at" TIMESTAMP(3)');
  });
});

describe(`${MIGRATION_NAME} foreign key DDL`, () => {
  it("adds only the organization and user cascade foreign keys", () => {
    expect(
      foreignKeys()
        .map((key) => key.name)
        .sort()
    ).toEqual([ORGANIZATION_FOREIGN_KEY, USER_FOREIGN_KEY].sort());
  });

  it("cascades organization and user deletion", () => {
    const organizationKey = foreignKeyNamed(ORGANIZATION_FOREIGN_KEY);
    expect(organizationKey.table).toBe(TABLE);
    expect(organizationKey.referencedTable).toBe("organizations");
    expect(organizationKey.columns).toBe('"organization_id"');
    expect(organizationKey.actions).toContain("ON DELETE CASCADE");

    const userKey = foreignKeyNamed(USER_FOREIGN_KEY);
    expect(userKey.table).toBe(TABLE);
    expect(userKey.referencedTable).toBe("users");
    expect(userKey.columns).toBe('"user_id"');
    expect(userKey.actions).toContain("ON DELETE CASCADE");
  });
});

function indexNamed(name: string) {
  const found = indexes().find((index) => index.name === name);
  if (!found) {
    throw new Error(`${MIGRATION_NAME}: missing index ${name}`);
  }
  return found;
}

function foreignKeyNamed(name: string) {
  const found = foreignKeys().find((key) => key.name === name);
  if (!found) {
    throw new Error(`${MIGRATION_NAME}: missing foreign key ${name}`);
  }
  return found;
}

function createTableColumns(): string[] {
  const match = CREATE_GRID_PREFERENCES_TABLE_RE.exec(
    migrationDdl(MIGRATION_NAME)
  );
  if (!match?.groups?.body) {
    throw new Error(`${MIGRATION_NAME}: missing ${TABLE} CREATE TABLE body`);
  }
  return match.groups.body
    .split("\n")
    .map((line) => line.trim().replace(TRAILING_COMMA_RE, ""));
}
