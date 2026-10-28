import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BASELINE_MIGRATIONS,
  COLLAPSED_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../../src/main/database/migration/baseline-schema.js";
import { MIGRATIONS } from "../../src/main/database/migration/migrations-manifest.js";
import { branchesDbPath } from "../e2e/helpers/desktop-seed-core.js";
import { openMigratedTestDatabase } from "../helpers/open-migrated-test-database.js";

// Executed through desktop-owned tsx, keeping production modules out of the E2E loader.
const profilePath = process.argv[2];
if (!(profilePath && path.isAbsolute(profilePath))) {
  throw new Error("a caller-owned absolute desktop profile path is required");
}
if (!fs.statSync(profilePath).isDirectory()) {
  throw new Error("desktop schema profile must already be a directory");
}
const databasePath = branchesDbPath(profilePath);
if (fs.existsSync(databasePath)) {
  throw new Error(
    "schema prototype requires a fresh caller-owned database path"
  );
}
const opened = await openMigratedTestDatabase(databasePath);
let receipt: object;
try {
  const recorded = await opened.db.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM "_desktop_migrations" ORDER BY name'
  );
  const expected = MIGRATIONS.map(({ name, checksum }) => ({
    name,
    checksum,
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(recorded.rows) !== JSON.stringify(expected)) {
    throw new Error(
      "initialized migration names or checksums differ from this source bundle"
    );
  }
  const schemaContract = {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
    collapsedMigrations: COLLAPSED_MIGRATIONS,
  };
  receipt = {
    migrations: expected,
    schemaContractSha256: createHash("sha256")
      .update(JSON.stringify(schemaContract))
      .digest("hex"),
    outcome: opened.outcome,
  };
} finally {
  await opened.db.close();
}
// Publication follows close: the caller may seed only after the child terminates successfully.
process.stdout.write(`${JSON.stringify(receipt)}\n`);
