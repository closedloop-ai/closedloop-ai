import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SeedCoverageStatus } from "@repo/api/src/seed-coverage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "../../../../generated/browser";
import { loadWebSeedCoverage } from "../../coverage";

describe("loadWebSeedCoverage", () => {
  let coverageDir = "";

  beforeEach(() => {
    coverageDir = mkdtempSync(path.join(tmpdir(), "web-seed-coverage-"));
  });

  afterEach(() => {
    rmSync(coverageDir, { recursive: true, force: true });
  });

  it("validates every .json file and skips the README", () => {
    writeFileSync(
      path.join(coverageDir, "Alpha.json"),
      JSON.stringify({ status: SeedCoverageStatus.Seeded, stage: "base-seed" })
    );
    writeFileSync(
      path.join(coverageDir, "Beta.json"),
      JSON.stringify({ status: SeedCoverageStatus.Seeded })
    );
    writeFileSync(path.join(coverageDir, "README.md"), "# Seed coverage");

    const coverage = loadWebSeedCoverage(coverageDir);

    expect([...coverage.keys()]).toEqual(["Alpha", "Beta"]);
    expect(coverage.get("Alpha")).toEqual({
      valid: true,
      entry: { status: SeedCoverageStatus.Seeded, stage: "base-seed" },
    });
    expect(coverage.get("Beta")?.valid).toBe(false);
  });

  it("reads the checked-in coverage folder by default", () => {
    expect(loadWebSeedCoverage().get(Prisma.ModelName.Organization)).toEqual({
      valid: true,
      entry: { status: SeedCoverageStatus.Seeded, stage: "base-seed" },
    });
  });
});
