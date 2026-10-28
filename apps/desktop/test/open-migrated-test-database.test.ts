import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  openMigrationDatabase,
  type SqliteClient,
} from "../src/main/database/migration/migration-executor.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";
import { openMigratedTestDatabase } from "./helpers/open-migrated-test-database.js";

vi.mock(
  "../src/main/database/migration/migration-executor.js",
  async (importOriginal) => {
    const module = await importOriginal<{
      openMigrationDatabase: typeof openMigrationDatabase;
    }>();
    return {
      ...module,
      openMigrationDatabase: vi.fn(module.openMigrationDatabase),
    };
  }
);

const roots: string[] = [];
const handles: SqliteClient[] = [];
const nativeOpen = vi.mocked(openMigrationDatabase).getMockImplementation();
if (!nativeOpen) {
  throw new Error("real migration opener was not retained by the unit fixture");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("migrates a caller-owned file through the complete production history and preserves its parent", async () => {
  const root = profile();
  const file = path.join(root, "store.sqlite");
  const opened = await openMigratedTestDatabase(file);
  handles.push(opened.db);
  const history = await opened.db.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM "_desktop_migrations" ORDER BY name'
  );
  expect(history.rows).toEqual(
    MIGRATIONS.map(({ name, checksum }) => ({ name, checksum })).sort(
      (left, right) => left.name.localeCompare(right.name)
    )
  );
  await opened.db.close();
  handles.splice(handles.indexOf(opened.db), 1);
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(root)).toBe(true);
}, 30_000);

test("unique caller profiles retain independent writes across close and reopen", async () => {
  const files = [profile(), profile()].map((root) =>
    path.join(root, "store.sqlite")
  );
  for (const [index, file] of files.entries()) {
    const { db } = await openMigratedTestDatabase(file);
    handles.push(db);
    await db.exec("CREATE TABLE fixture_ownership (value INTEGER NOT NULL)");
    await db.query("INSERT INTO fixture_ownership (value) VALUES ($1)", [
      index,
    ]);
    await db.close();
    handles.splice(handles.indexOf(db), 1);
  }
  for (const [index, file] of files.entries()) {
    const { db } = await openMigratedTestDatabase(file);
    handles.push(db);
    expect(
      (await db.query("SELECT value FROM fixture_ownership")).rows
    ).toEqual([{ value: index }]);
  }
}, 30_000);

test("checksum refusal closes the actual opened writer while preserving the caller profile", async () => {
  const file = path.join(profile(), "store.sqlite");
  const first = await openMigratedTestDatabase(file);
  handles.push(first.db);
  const last = MIGRATIONS.at(-1);
  if (!last) {
    throw new Error("production migration history is empty");
  }
  await first.db.query(
    'UPDATE "_desktop_migrations" SET checksum = $1 WHERE name = $2',
    ["deliberately-changed-checksum", last.name]
  );
  await first.db.close();
  handles.splice(handles.indexOf(first.db), 1);
  const opened = await nativeOpen(file);
  handles.push(opened.db);
  const close = vi.spyOn(opened.db, "close");
  vi.mocked(openMigrationDatabase).mockResolvedValueOnce(opened);
  await expect(openMigratedTestDatabase(file)).rejects.toThrow();
  expect(close).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(file)).toBe(true);
}, 30_000);

test("rejects relative paths before opening any native writer", async () => {
  const open = vi.mocked(openMigrationDatabase);
  await expect(openMigratedTestDatabase("relative.sqlite")).rejects.toThrow(
    "absolute"
  );
  expect(open).not.toHaveBeenCalled();
});

function profile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caller-schema-"));
  roots.push(root);
  return root;
}
