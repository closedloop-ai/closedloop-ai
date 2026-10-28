import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "@repo/observability/log";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import {
  deleteDocumentState,
  documentStateExists,
  listDocumentNames,
  loadDocumentState,
  saveDocumentState,
} from "../storage/document-state";
import {
  MIGRATION_FAILED_EVENT,
  MIGRATION_LOCK_KEY,
  MIGRATIONS_DIR,
  MigrationError,
  runMigrations,
  runMigrationsOrExit,
} from "../storage/migrate";
import { integrationPg } from "./integration/integration-env";
import {
  createTestSchema,
  type TestSchema,
  waitFor,
} from "./integration/test-schema";

const FIRST_MIGRATION = "0001_document_state";
const TEXT = "content";
const RACING_DOCUMENTS = 10;
const DELETED_TEXT = "secret";

/** A full state from a fresh Y.Doc holding `text`, as a separate writer's copy would be. */
function stateWith(text: string): Uint8Array {
  const doc = new Doc();
  doc.getText(TEXT).insert(0, text);
  return encodeStateAsUpdate(doc);
}

function textOf(state: Uint8Array | null): string {
  const doc = new Doc();
  if (state) {
    applyUpdate(doc, state);
  }
  return doc.getText(TEXT).toString();
}

async function recordedMigrations(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM doc_sync_migration ORDER BY id"
  );
  return rows.map((row) => row.id);
}

describe.skipIf(!integrationPg)("document state in Postgres", () => {
  let schema: TestSchema;
  let pool: pg.Pool;

  beforeEach(async () => {
    if (!integrationPg) {
      return;
    }
    schema = await createTestSchema(integrationPg);
    pool = schema.connect();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await schema?.drop();
  });

  describe("store", () => {
    beforeEach(async () => {
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    it("loads null for a document never stored", async () => {
      await expect(loadDocumentState(pool, "doc-never-stored")).resolves.toBe(
        null
      );
    });

    it("keeps both writers' edits when two copies save one after the other", async () => {
      await saveDocumentState(pool, "doc-a", stateWith("alpha"));
      await saveDocumentState(pool, "doc-a", stateWith("beta"));

      const text = textOf(await loadDocumentState(pool, "doc-a"));
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
    });

    it("keeps both edits when two first saves of a new row race", async () => {
      const names = Array.from(
        { length: RACING_DOCUMENTS },
        (_, index) => `doc-race-${index}`
      );

      await Promise.all(
        names.flatMap((name) => [
          saveDocumentState(pool, name, stateWith("first")),
          saveDocumentState(pool, name, stateWith("second")),
        ])
      );

      for (const name of names) {
        const text = textOf(await loadDocumentState(pool, name));
        expect(text).toContain("first");
        expect(text).toContain("second");
      }
    });

    it("stores the save when the row is deleted between its conflict and its lock", async () => {
      await saveDocumentState(pool, "doc-deleted-mid-save", stateWith("old"));
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT name FROM document_state WHERE name = $1 FOR UPDATE",
          ["doc-deleted-mid-save"]
        );
        const saved = saveDocumentState(
          pool,
          "doc-deleted-mid-save",
          stateWith("new")
        );
        await waitFor(async () => {
          const { rows } = await pool.query<{ waiting: number }>(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE '%FOR UPDATE%'`
          );
          return rows[0]?.waiting === 1;
        }, "the save to queue on the row lock");

        await holder.query("DELETE FROM document_state WHERE name = $1", [
          "doc-deleted-mid-save",
        ]);
        await holder.query("COMMIT");
        await saved;
      } finally {
        holder.release();
      }

      const text = textOf(
        await loadDocumentState(pool, "doc-deleted-mid-save")
      );
      expect(text).toBe("new");
    });

    it("keeps no bytes of text deleted before a later save", async () => {
      const doc = new Doc();
      doc.getText(TEXT).insert(0, DELETED_TEXT);
      await saveDocumentState(pool, "doc-erased", encodeStateAsUpdate(doc));
      doc.getText(TEXT).delete(0, DELETED_TEXT.length);
      await saveDocumentState(pool, "doc-erased", encodeStateAsUpdate(doc));
      await saveDocumentState(pool, "doc-erased", encodeStateAsUpdate(doc));

      const { rows } = await pool.query<{ state: Buffer }>(
        "SELECT state FROM document_state WHERE name = $1",
        ["doc-erased"]
      );
      expect(rows[0]?.state.includes(Buffer.from(DELETED_TEXT))).toBe(false);
      expect(textOf(await loadDocumentState(pool, "doc-erased"))).toBe("");
    });

    it("deletes a stored document, reporting whether a row existed", async () => {
      await saveDocumentState(pool, "doc-delete", stateWith("gone"));

      await expect(deleteDocumentState(pool, "doc-delete")).resolves.toBe(true);
      await expect(loadDocumentState(pool, "doc-delete")).resolves.toBe(null);
      await expect(deleteDocumentState(pool, "doc-delete")).resolves.toBe(
        false
      );
    });

    it("reports whether a row is stored", async () => {
      await saveDocumentState(pool, "doc-exists", stateWith("here"));

      await expect(documentStateExists(pool, "doc-exists")).resolves.toBe(true);
      await expect(documentStateExists(pool, "doc-absent")).resolves.toBe(
        false
      );
    });

    it("lists stored names in order, after a cursor and up to a limit", async () => {
      for (const name of ["doc-c", "doc-a", "doc-b"]) {
        await saveDocumentState(pool, name, stateWith(name));
      }

      await expect(listDocumentNames(pool, undefined, 2)).resolves.toEqual([
        "doc-a",
        "doc-b",
      ]);
      await expect(listDocumentNames(pool, "doc-b", 2)).resolves.toEqual([
        "doc-c",
      ]);
    });
  });

  describe("migrations", () => {
    let brokenDir: string | undefined;

    afterEach(async () => {
      if (brokenDir) {
        await rm(brokenDir, { recursive: true, force: true });
        brokenDir = undefined;
      }
    });

    async function dirWithBrokenSecondMigration(): Promise<string> {
      brokenDir = await mkdtemp(path.join(tmpdir(), "doc-sync-migrations-"));
      await cp(MIGRATIONS_DIR, brokenDir, { recursive: true });
      await writeFile(
        path.join(brokenDir, "0002_broken.sql"),
        "CREATE TABLE broken_probe (id integer);\nSELECT 1 / 0;\n"
      );
      return brokenDir;
    }

    it("applies each migration once; a second run is a no-op", async () => {
      await expect(runMigrations(pool, MIGRATIONS_DIR)).resolves.toEqual([
        FIRST_MIGRATION,
      ]);
      await expect(runMigrations(pool, MIGRATIONS_DIR)).resolves.toEqual([]);
      await expect(recordedMigrations(pool)).resolves.toEqual([
        FIRST_MIGRATION,
      ]);
    });

    it("rolls a failing migration back whole and records nothing for it", async () => {
      const dir = await dirWithBrokenSecondMigration();

      const failure = await runMigrations(pool, dir).catch(
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(MigrationError);
      expect(failure).toMatchObject({ migrationId: "0002_broken" });
      await expect(recordedMigrations(pool)).resolves.toEqual([
        FIRST_MIGRATION,
      ]);
      const probe = await pool.query<{ table: string | null }>(
        "SELECT to_regclass('broken_probe')::text AS table"
      );
      expect(probe.rows[0]?.table).toBeNull();
    });

    it("waits for the advisory lock another session holds before migrating", async () => {
      const holder = await pool.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
        let settled = false;
        const migrated = runMigrations(pool, MIGRATIONS_DIR).finally(() => {
          settled = true;
        });
        await waitFor(async () => {
          const { rows } = await pool.query<{ waiting: number }>(
            `SELECT count(*)::int AS waiting FROM pg_locks
              WHERE locktype = 'advisory' AND objid = $1 AND NOT granted
                AND database = (
                  SELECT oid FROM pg_database WHERE datname = current_database()
                )`,
            [MIGRATION_LOCK_KEY]
          );
          return rows[0]?.waiting === 1;
        }, "the migration to queue on the advisory lock");
        expect(settled).toBe(false);

        await holder.query("SELECT pg_advisory_unlock($1)", [
          MIGRATION_LOCK_KEY,
        ]);
        await expect(migrated).resolves.toEqual([FIRST_MIGRATION]);
      } finally {
        holder.release();
      }
    });

    it("refuses to boot when a migration fails: logs doc_sync.migration_failed, flushes, exits 1", async () => {
      const dir = await dirWithBrokenSecondMigration();
      const order: string[] = [];
      const error = vi.spyOn(log, "error").mockImplementation(() => {
        order.push("log");
      });
      const exit = vi.fn(() => {
        order.push("exit");
      });
      const flushLogs = vi.fn(() => {
        order.push("flush");
        return Promise.resolve();
      });

      await expect(
        runMigrationsOrExit(pool, dir, { exit, flushLogs })
      ).resolves.toBe(false);

      expect(order).toEqual(["log", "flush", "exit"]);
      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledWith(expect.any(String), {
        event: MIGRATION_FAILED_EVENT,
        fatal: true,
        migrationId: "0002_broken",
        code: "22012",
      });
    });
  });
});
