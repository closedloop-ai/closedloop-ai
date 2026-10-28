/**
 * ISS-12394 — the migrations-manifest generator's refusal and write branches,
 * driven against temp fixtures.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMigrationEntries,
  generateMigrationsManifest,
  healLegacyManifest,
  legacyManifestPath,
  readMigrationDirNames,
  renderManifest,
  writeManifestIfChanged,
} from "../scripts/generate-migrations-manifest-lib.mjs";

const NO_MIGRATIONS_RE = /no migrations found in /;
const NON_SYMLINK_RE =
  /prisma\/migrations\/0001_a\/migration\.sql must be a regular, non-symlink file/;
const NOT_A_FILE_RE =
  /prisma\/migrations\/0002_dir\/migration\.sql must be a regular, non-symlink file/;
const ESCAPES_RE =
  /prisma\/migrations\/0003_escape\/migration\.sql resolves outside prisma\/migrations/;
const LEGACY_FAILURE_RE =
  /^generate-migrations-manifest: could not remove legacy src\/main\/database\/migrations-manifest\.ts \(.+\)\n$/;

let appDir = "";
let migrationsDir = "";
let outFile = "";

beforeEach(() => {
  appDir = mkdtempSync(path.join(tmpdir(), "migrations-iss12394-"));
  migrationsDir = path.join(appDir, "prisma", "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  outFile = path.join(appDir, "manifest.ts");
});

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true });
});

function writeMigration(name: string, sql: string): void {
  mkdirSync(path.join(migrationsDir, name), { recursive: true });
  writeFileSync(path.join(migrationsDir, name, "migration.sql"), sql, "utf8");
}

describe("healLegacyManifest", () => {
  it("reports an Error's message and does not throw when removal fails", () => {
    const legacy = legacyManifestPath(appDir);
    // A directory at the legacy path makes a non-recursive rmSync throw.
    mkdirSync(path.join(legacy, "child"), { recursive: true });
    const lines: string[] = [];

    healLegacyManifest(appDir, (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(LEGACY_FAILURE_RE);
    expect(existsSync(legacy)).toBe(true);
  });

  it("removes an existing legacy file silently", () => {
    const legacy = legacyManifestPath(appDir);
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, "stale", "utf8");
    const lines: string[] = [];

    healLegacyManifest(appDir, (line) => lines.push(line));

    expect(lines).toEqual([]);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe("readMigrationDirNames", () => {
  it("throws when there are no migration directories", () => {
    writeFileSync(path.join(migrationsDir, "README.md"), "x", "utf8");
    expect(() => readMigrationDirNames(migrationsDir)).toThrow(
      NO_MIGRATIONS_RE
    );
  });
});

describe("buildMigrationEntries", () => {
  it("rejects a symlinked migration.sql", () => {
    mkdirSync(path.join(migrationsDir, "0001_a"));
    writeFileSync(path.join(appDir, "real.sql"), "SELECT 1;", "utf8");
    symlinkSync(
      path.join(appDir, "real.sql"),
      path.join(migrationsDir, "0001_a", "migration.sql")
    );
    expect(() =>
      buildMigrationEntries(["0001_a"], { appDir, migrationsDir })
    ).toThrow(NON_SYMLINK_RE);
  });

  it("rejects a migration.sql that is a directory", () => {
    mkdirSync(path.join(migrationsDir, "0002_dir", "migration.sql"), {
      recursive: true,
    });
    expect(() =>
      buildMigrationEntries(["0002_dir"], { appDir, migrationsDir })
    ).toThrow(NOT_A_FILE_RE);
  });

  it("rejects a migration whose directory resolves outside the migrations root", () => {
    const outside = path.join(appDir, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "migration.sql"), "SELECT 2;", "utf8");
    symlinkSync(outside, path.join(migrationsDir, "0003_escape"));
    expect(() =>
      buildMigrationEntries(["0003_escape"], { appDir, migrationsDir })
    ).toThrow(ESCAPES_RE);
  });
});

describe("writeManifestIfChanged", () => {
  it("writes and reports when the file is absent", () => {
    const lines: string[] = [];
    const wrote = writeManifestIfChanged({
      appDir,
      outFile,
      contents: "X",
      migrationCount: 2,
      writeLine: (line) => lines.push(line),
    });
    expect(wrote).toBe(true);
    expect(readFileSync(outFile, "utf8")).toBe("X");
    expect(lines).toEqual([
      "generate-migrations-manifest: wrote 2 migration(s) to manifest.ts\n",
    ]);
  });

  it("reports to stdout when no writeLine is injected", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      writeManifestIfChanged({
        appDir,
        outFile,
        contents: "X",
        migrationCount: 1,
      });
      expect(spy).toHaveBeenCalledWith(
        "generate-migrations-manifest: wrote 1 migration(s) to manifest.ts\n"
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rewrites a stale file", () => {
    writeFileSync(outFile, "OLD", "utf8");
    const wrote = writeManifestIfChanged({
      appDir,
      outFile,
      contents: "NEW",
      migrationCount: 1,
      writeLine: () => undefined,
    });
    expect(wrote).toBe(true);
    expect(readFileSync(outFile, "utf8")).toBe("NEW");
  });
});

describe("generateMigrationsManifest", () => {
  it("writes on first run and reports unchanged on the second", () => {
    writeMigration("0002_b", "SELECT 2;");
    writeMigration("0001_a", "SELECT 1;");
    const lines: string[] = [];
    const writeLine = (line: string) => lines.push(line);

    const first = generateMigrationsManifest({
      appDir,
      migrationsDir,
      outFile,
      writeLine,
    });
    const expectedEntries = [
      {
        name: "0001_a",
        checksum: createHash("sha256").update("SELECT 1;").digest("hex"),
        sql: "SELECT 1;",
      },
      {
        name: "0002_b",
        checksum: createHash("sha256").update("SELECT 2;").digest("hex"),
        sql: "SELECT 2;",
      },
    ];
    expect(first.wrote).toBe(true);
    expect(first.entries).toEqual(expectedEntries);
    expect(first.contents).toBe(renderManifest(expectedEntries));
    expect(readFileSync(outFile, "utf8")).toBe(first.contents);

    const second = generateMigrationsManifest({
      appDir,
      migrationsDir,
      outFile,
      writeLine,
    });
    expect(second.wrote).toBe(false);
    expect(lines.at(-1)).toBe(
      "generate-migrations-manifest: unchanged (2 migration(s))\n"
    );
  });
});
