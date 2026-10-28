import path from "node:path";
import {
  BASELINE_MIGRATIONS,
  COLLAPSED_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../../src/main/database/migration/baseline-schema.js";
import { openMigrationDatabase } from "../../src/main/database/migration/migration-executor.js";
import { runDesktopMigrations } from "../../src/main/database/migration/migration-runner.js";
import { MIGRATIONS } from "../../src/main/database/migration/migrations-manifest.js";

/** Opens a caller-owned SQLite file through production migrations; never removes it. */
export async function openMigratedTestDatabase(databasePath: string) {
  if (!path.isAbsolute(databasePath)) {
    throw new Error("test migration database path must be absolute");
  }
  const opened = await openMigrationDatabase(databasePath);
  try {
    const outcome = await runDesktopMigrations(opened.db, {
      migrations: MIGRATIONS,
      baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
      baselineMigrations: BASELINE_MIGRATIONS,
      collapsedMigrations: COLLAPSED_MIGRATIONS,
    });
    return { ...opened, outcome };
  } catch (error) {
    await opened.db.close().catch(() => undefined);
    throw error;
  }
}
