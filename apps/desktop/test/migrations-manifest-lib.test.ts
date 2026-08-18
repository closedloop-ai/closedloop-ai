import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildMigrationEntries,
  generateMigrationsManifest,
  healLegacyManifest,
  legacyManifestPath,
  type MigrationManifestEntry,
  readMigrationDirNames,
  renderManifest,
  writeManifestIfChanged,
} from "../scripts/generate-migrations-manifest-lib.mjs";

const DESKTOP_DIR = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const ENTRYPOINT = path.join(
  DESKTOP_DIR,
  "scripts",
  "generate-migrations-manifest.mjs"
);

/**
 * The entrypoint reads the migration tree and writes one module; anything
 * approaching this is a hang, not a slow machine. node:test's own `timeout`
 * cannot interrupt `spawnSync` (it blocks this worker's event loop), so the
 * child gets its own deadline and the case a strictly larger one — the case can
 * run the entrypoint twice, and a per-case budget that merely MATCHED the
 * child's would expire before the second child's deadline could report.
 */
const SPAWN_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 120_000;

const REAL_MIGRATIONS_DIR = path.join(DESKTOP_DIR, "prisma", "migrations");
const REAL_OUT_FILE = path.join(
  DESKTOP_DIR,
  "src",
  "main",
  "database",
  "migration",
  "migrations-manifest.ts"
);

const OUT_FILE_RELATIVE = path.join(
  "src",
  "main",
  "database",
  "migration",
  "migrations-manifest.ts"
);
const LEGACY_RELATIVE = path.join(
  "src",
  "main",
  "database",
  "migrations-manifest.ts"
);
const MIGRATIONS_RELATIVE = path.join("prisma", "migrations");

// sha256 of the exact bytes below, computed independently of the generator.
const KNOWN_SQL = "-- ISS-5303 known bytes\nSELECT 1;\n";
const KNOWN_SQL_SHA256 =
  "84382aac1d5151428c29972f78a020ce409bf7874aea2a261fa33a3a2b0c4d64";
const SIMPLE_SQL = "SELECT 1;";
const SIMPLE_SQL_SHA256 =
  "17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a";

const tempRoots: string[] = [];

type Fixture = {
  appDir: string;
  migrationsDir: string;
  outFile: string;
};

// `realpathSync` because the message assertions below compare rendered
// `path.relative(appDir, …)` output, and an unresolved symlinked tmpdir (macOS
// /var -> /private/var) would make every one of them fail for the wrong reason.
function createFixture(): Fixture {
  const appDir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "iss5303-manifest-"))
  );
  tempRoots.push(appDir);
  const migrationsDir = path.join(appDir, MIGRATIONS_RELATIVE);
  mkdirSync(migrationsDir, { recursive: true });
  const outFile = path.join(appDir, OUT_FILE_RELATIVE);
  mkdirSync(path.dirname(outFile), { recursive: true });
  return { appDir, migrationsDir, outFile };
}

function addMigration(fixture: Fixture, name: string, sql: string): string {
  const dir = path.join(fixture.migrationsDir, name);
  mkdirSync(dir, { recursive: true });
  const sqlPath = path.join(dir, "migration.sql");
  writeFileSync(sqlPath, sql, "utf8");
  return sqlPath;
}

function runEntrypoint(): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [ENTRYPOINT], {
    cwd: DESKTOP_DIR,
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: SPAWN_TIMEOUT_MS,
  });
  // spawnSync reports a launch failure — and a `timeout` kill — on `.error`
  // rather than throwing, so without this a missing entrypoint or a wedged
  // child surfaces as a confusing null status and an empty stdout.
  if (result.error) {
    throw new Error(
      `generate-migrations-manifest did not exit on its own: ${result.error.message}`
    );
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ISS-5303: the embedded-migrations generator's file guards", () => {
  test("rejects a symlinked migration.sql", () => {
    // The embedded SQL runs at app boot, so a migration.sql that is a symlink
    // could point the packaged app at content nobody reviewed.
    const fixture = createFixture();
    addMigration(fixture, "0001_real", "-- real\n");
    const linkedDir = path.join(fixture.migrationsDir, "0002_linked");
    mkdirSync(linkedDir);
    symlinkSync(
      path.join(fixture.migrationsDir, "0001_real", "migration.sql"),
      path.join(linkedDir, "migration.sql")
    );

    assert.throws(
      () =>
        generateMigrationsManifest({ ...fixture, writeLine: () => undefined }),
      {
        message: `generate-migrations-manifest: ${path.join(MIGRATIONS_RELATIVE, "0002_linked", "migration.sql")} must be a regular, non-symlink file`,
      }
    );
    assert.equal(
      existsSync(fixture.outFile),
      false,
      "a rejected migration must not leave a partial manifest behind"
    );
  });

  test("rejects a migration.sql whose realpath escapes the migrations root", () => {
    const fixture = createFixture();
    addMigration(fixture, "0001_real", "-- real\n");
    const outsideDir = path.join(fixture.appDir, "outside");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      path.join(outsideDir, "migration.sql"),
      "-- outside\n",
      "utf8"
    );
    symlinkSync(
      outsideDir,
      path.join(fixture.migrationsDir, "0002_escape"),
      "dir"
    );

    // Layer one: readdir reports a symlinked directory as a symlink, not a
    // directory, so the scan never yields the name in the first place.
    assert.deepEqual(readMigrationDirNames(fixture.migrationsDir), [
      "0001_real",
    ]);

    // Layer two, which is the one under test: lstat on a migration.sql reached
    // THROUGH a symlinked directory follows the intermediate link and reports a
    // regular, non-symlink file, so the check above it passes. Only the
    // realpath comparison stops the escape, and it must fire for any name a
    // caller hands in.
    assert.throws(() => buildMigrationEntries(["0002_escape"], fixture), {
      message: `generate-migrations-manifest: ${path.join(MIGRATIONS_RELATIVE, "0002_escape", "migration.sql")} resolves outside ${MIGRATIONS_RELATIVE}`,
    });
  });

  test("refuses to emit a manifest for an empty migrations directory", () => {
    // An empty manifest is not a valid degraded state: it would ship an app
    // whose runtime runner believes it has nothing to apply.
    const fixture = createFixture();
    const expected = {
      message: `generate-migrations-manifest: no migrations found in ${fixture.migrationsDir}`,
    };

    assert.throws(() => readMigrationDirNames(fixture.migrationsDir), expected);
    assert.throws(
      () =>
        generateMigrationsManifest({ ...fixture, writeLine: () => undefined }),
      expected
    );
    assert.equal(existsSync(fixture.outFile), false);
  });
});

describe("ISS-5303: the embedded-migrations manifest contents", () => {
  test("checksums the raw migration.sql bytes with sha256", () => {
    const fixture = createFixture();
    addMigration(fixture, "0001_known", KNOWN_SQL);

    const entries = buildMigrationEntries(["0001_known"], fixture);

    assert.deepEqual(entries, [
      {
        name: "0001_known",
        checksum: KNOWN_SQL_SHA256,
        sql: KNOWN_SQL,
      },
    ]);
  });

  test("orders migrations with the shared compareMigrationDirNames comparator", () => {
    const fixture = createFixture();
    // The FEA-2030 timestamp-prefixed migration sorts at its legacy 0004 slot,
    // and the second 0011_ migration sorts at 0012. Both are immutable, so the
    // order only comes out right if the comparator is used.
    for (const name of [
      "0005_e",
      "0001_a",
      "20260619220000_add_genai_prices_pricing_source",
      "0011_session_activity_segments",
      "0011_clear_default_branch_pr_poison",
    ]) {
      addMigration(fixture, name, `-- ${name}\n`);
    }
    // The real prisma/migrations carries a migration_lock.toml alongside the
    // directories; it must not become a manifest entry.
    writeFileSync(
      path.join(fixture.migrationsDir, "migration_lock.toml"),
      'provider = "sqlite"\n',
      "utf8"
    );

    const ordered = readMigrationDirNames(fixture.migrationsDir);

    assert.deepEqual(ordered, [
      "0001_a",
      "20260619220000_add_genai_prices_pricing_source",
      "0005_e",
      "0011_clear_default_branch_pr_poison",
      "0011_session_activity_segments",
    ]);
    // A plain lexicographic sort strands the timestamp-prefixed migration at
    // the end, after every 00NN_ migration that already ran before it.
    assert.notDeepEqual([...ordered].sort(), ordered);
  });

  test("renders the module the SQLite runner imports", () => {
    const entries: MigrationManifestEntry[] = [
      {
        name: "0001_init",
        checksum: SIMPLE_SQL_SHA256,
        sql: SIMPLE_SQL,
      },
    ];

    assert.equal(
      renderManifest(entries),
      `// AUTO-GENERATED by scripts/generate-migrations-manifest.mjs — do not edit.
// FEA-1791 / PLN-886 Phase 2: ordered embedded migrations for the desktop
// SQLite runtime migration runner. Regenerated by \`pnpm prebuild\`.
import type { EmbeddedMigration } from "./migration-runner.js";

export const MIGRATIONS: readonly EmbeddedMigration[] = [
  {
    name: "0001_init",
    checksum: "${SIMPLE_SQL_SHA256}",
    sql: "${SIMPLE_SQL}",
  },
];
`
    );
  });

  test("escapes SQL so the generated module stays parseable", () => {
    // Real migrations contain newlines and quoted identifiers. An unescaped
    // one would emit a .ts file that does not compile, and the failure would
    // surface as an unrelated typecheck error three steps later.
    const fixture = createFixture();
    addMigration(fixture, "0001_quotes", '-- "quoted"\nSELECT 1;\n');

    const rendered = renderManifest(
      buildMigrationEntries(["0001_quotes"], fixture)
    );

    assert.ok(
      rendered.includes(String.raw`    sql: "-- \"quoted\"\nSELECT 1;\n",`),
      rendered
    );
  });

  test("writes the manifest once, then reports it unchanged", () => {
    const fixture = createFixture();
    addMigration(fixture, "0001_a", "-- a\n");
    addMigration(fixture, "0002_b", "-- b\n");
    const lines: string[] = [];
    const writeLine = (line: string) => {
      lines.push(line);
    };

    const first = generateMigrationsManifest({ ...fixture, writeLine });

    assert.equal(first.wrote, true);
    assert.deepEqual(lines, [
      `generate-migrations-manifest: wrote 2 migration(s) to ${OUT_FILE_RELATIVE}\n`,
    ]);
    assert.equal(readFileSync(fixture.outFile, "utf8"), first.contents);

    lines.length = 0;
    const second = generateMigrationsManifest({ ...fixture, writeLine });

    assert.equal(second.wrote, false);
    assert.deepEqual(lines, [
      "generate-migrations-manifest: unchanged (2 migration(s))\n",
    ]);
    assert.equal(second.contents, first.contents);
  });

  test("rewrites the manifest when a migration's bytes change", () => {
    const fixture = createFixture();
    addMigration(fixture, "0001_a", "-- a\n");
    generateMigrationsManifest({ ...fixture, writeLine: () => undefined });

    addMigration(fixture, "0001_a", "-- a changed\n");
    const lines: string[] = [];
    const again = generateMigrationsManifest({
      ...fixture,
      writeLine: (line) => {
        lines.push(line);
      },
    });

    assert.equal(again.wrote, true);
    assert.deepEqual(lines, [
      `generate-migrations-manifest: wrote 1 migration(s) to ${OUT_FILE_RELATIVE}\n`,
    ]);
    assert.equal(readFileSync(fixture.outFile, "utf8"), again.contents);
    assert.ok(again.contents.includes("-- a changed"));
  });

  test("writeManifestIfChanged does not touch a file whose bytes already match", () => {
    const fixture = createFixture();
    writeFileSync(fixture.outFile, "same", "utf8");
    const lines: string[] = [];

    const wrote = writeManifestIfChanged({
      appDir: fixture.appDir,
      outFile: fixture.outFile,
      contents: "same",
      migrationCount: 7,
      writeLine: (line) => {
        lines.push(line);
      },
    });

    assert.equal(wrote, false);
    assert.deepEqual(lines, [
      "generate-migrations-manifest: unchanged (7 migration(s))\n",
    ]);
  });
});

describe("ISS-5303: the ISS-5185 legacy manifest heal", () => {
  test("targets the pre-ISS-5185 path, not the live output", () => {
    // Pointing the heal at the current output would delete the artifact the
    // build just produced, on every prebuild.
    const fixture = createFixture();

    assert.equal(
      legacyManifestPath(fixture.appDir),
      path.join(fixture.appDir, LEGACY_RELATIVE)
    );
    assert.notEqual(legacyManifestPath(fixture.appDir), fixture.outFile);
  });

  test("removes a stale legacy manifest", () => {
    const fixture = createFixture();
    const legacy = legacyManifestPath(fixture.appDir);
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, "// stale\n", "utf8");
    const lines: string[] = [];

    healLegacyManifest(fixture.appDir, (line) => {
      lines.push(line);
    });

    assert.equal(existsSync(legacy), false);
    assert.deepEqual(lines, []);
  });

  test("tolerates a missing legacy manifest", () => {
    // The normal case on a fresh checkout. A throw here would fail prebuild,
    // and prebuild gates build, typecheck and test.
    const fixture = createFixture();
    const lines: string[] = [];

    healLegacyManifest(fixture.appDir, (line) => {
      lines.push(line);
    });

    assert.deepEqual(lines, []);
  });

  test("reports, but does not abort on, a legacy path it cannot remove", () => {
    const fixture = createFixture();
    const legacy = legacyManifestPath(fixture.appDir);
    mkdirSync(legacy, { recursive: true });
    const lines: string[] = [];

    healLegacyManifest(fixture.appDir, (line) => {
      lines.push(line);
    });

    assert.equal(lines.length, 1);
    assert.ok(
      lines[0].startsWith(
        `generate-migrations-manifest: could not remove legacy ${LEGACY_RELATIVE} (`
      ),
      lines[0]
    );
    assert.ok(lines[0].endsWith(")\n"), lines[0]);
    assert.equal(existsSync(legacy), true);
  });

  test("runs as part of a full generate", () => {
    // The heal is easy to drop when the entrypoint is refactored; a lib test
    // that only calls healLegacyManifest directly would not notice.
    const fixture = createFixture();
    addMigration(fixture, "0001_a", "-- a\n");
    const legacy = legacyManifestPath(fixture.appDir);
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, "// stale\n", "utf8");

    generateMigrationsManifest({ ...fixture, writeLine: () => undefined });

    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(fixture.outFile), true);
  });
});

describe("ISS-5303: scripts/generate-migrations-manifest.mjs wiring", () => {
  test("drives the lib with the real desktop paths", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const migrationNames = readMigrationDirNames(REAL_MIGRATIONS_DIR);
    const expected = renderManifest(
      buildMigrationEntries(migrationNames, {
        appDir: DESKTOP_DIR,
        migrationsDir: REAL_MIGRATIONS_DIR,
      })
    );

    // `pnpm prebuild` runs ahead of `test:node`, so the manifest on disk is
    // normally already current and this branch is a no-op. It only fires when
    // the suite is run without prebuild, and exists so the assertion below
    // can demand the exact "unchanged" line rather than accepting either.
    if (
      !existsSync(REAL_OUT_FILE) ||
      readFileSync(REAL_OUT_FILE, "utf8") !== expected
    ) {
      runEntrypoint();
    }
    const before = readFileSync(REAL_OUT_FILE);

    const result = runEntrypoint();

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    // Deleting the lib call from the entrypoint empties stdout, and pointing
    // it at anything but the real prisma/migrations changes the count or
    // throws.
    assert.equal(
      result.stdout,
      `generate-migrations-manifest: unchanged (${migrationNames.length} migration(s))\n`
    );
    // Byte-for-byte: the shipped manifest is exactly what the lib renders for
    // the real migrations, and running the entrypoint again does not move it.
    assert.deepEqual(readFileSync(REAL_OUT_FILE), before);
    assert.equal(before.toString("utf8"), expected);
  });
});
