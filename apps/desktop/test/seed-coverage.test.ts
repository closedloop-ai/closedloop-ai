/**
 * ISS-12017: every Desktop Prisma model declares whether the seeded Desktop
 * profile fills it, in one JSON file per model under prisma/seed-coverage (see
 * its README.md). The model list comes from the generated client, never from
 * schema text.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compareCoverage,
  describeInvalidSeedCoverage,
  describeMissingSeedCoverage,
  describeStaleSeedCoverage,
  SeedCoverageStatus,
} from "@repo/api/src/seed-coverage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESKTOP_SEED_COVERAGE_DIR_LABEL,
  loadDesktopSeedCoverage,
} from "../scripts/seed-coverage.js";
import { Prisma } from "../src/main/database/generated/browser.js";

const modelNames = Object.values(Prisma.ModelName);
const comparison = compareCoverage(modelNames, loadDesktopSeedCoverage());

describe("Desktop seed coverage", () => {
  it("reads a non-empty model list from the generated client", () => {
    expect(modelNames.length).toBeGreaterThan(0);
  });

  it("has a coverage file for every Prisma model", () => {
    expect(
      comparison.missing,
      describeMissingSeedCoverage(
        comparison.missing,
        DESKTOP_SEED_COVERAGE_DIR_LABEL
      )
    ).toEqual([]);
  });

  it("has no coverage file for a model the schema does not have", () => {
    expect(
      comparison.stale,
      describeStaleSeedCoverage(
        comparison.stale,
        DESKTOP_SEED_COVERAGE_DIR_LABEL
      )
    ).toEqual([]);
  });

  it("has only valid coverage files", () => {
    expect(
      comparison.invalid,
      describeInvalidSeedCoverage(
        comparison.invalid,
        DESKTOP_SEED_COVERAGE_DIR_LABEL
      )
    ).toEqual([]);
  });
});

describe("loadDesktopSeedCoverage", () => {
  let coverageDir = "";

  beforeEach(() => {
    coverageDir = mkdtempSync(path.join(tmpdir(), "desktop-seed-coverage-"));
  });

  afterEach(() => {
    rmSync(coverageDir, { recursive: true, force: true });
  });

  it("validates every .json file and skips the README", () => {
    writeFileSync(
      path.join(coverageDir, "Alpha.json"),
      JSON.stringify({
        status: SeedCoverageStatus.Skipped,
        reason: "Sync cursor only.",
      })
    );
    writeFileSync(
      path.join(coverageDir, "Beta.json"),
      JSON.stringify({ status: SeedCoverageStatus.Skipped })
    );
    writeFileSync(path.join(coverageDir, "README.md"), "# Seed coverage");

    const coverage = loadDesktopSeedCoverage(coverageDir);

    expect([...coverage.keys()]).toEqual(["Alpha", "Beta"]);
    expect(coverage.get("Alpha")).toEqual({
      valid: true,
      entry: {
        status: SeedCoverageStatus.Skipped,
        reason: "Sync cursor only.",
      },
    });
    expect(coverage.get("Beta")?.valid).toBe(false);
  });

  it("reads the checked-in coverage folder by default", () => {
    expect(loadDesktopSeedCoverage().get(Prisma.ModelName.Session)).toEqual({
      valid: true,
      entry: { status: SeedCoverageStatus.Seeded, stage: "golden-import" },
    });
  });
});
