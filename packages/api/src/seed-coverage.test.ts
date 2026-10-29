import { describe, expect, it } from "vitest";
import {
  compareCoverage,
  describeInvalidSeedCoverage,
  describeMissingSeedCoverage,
  describeStaleSeedCoverage,
  parseSeedCoverageContents,
  parseSeedCoverageDirectory,
  type SeedCoverage,
  type SeedCoverageEntry,
  type SeedCoverageRecord,
  SeedCoverageStatus,
} from "./seed-coverage.ts";

const COVERAGE_DIR = "packages/example/coverage";

describe("parseSeedCoverageContents", () => {
  it.each<[string, SeedCoverageEntry]>([
    [
      "seeded with a stage",
      { status: SeedCoverageStatus.Seeded, stage: "base-seed" },
    ],
    [
      "skipped with a reason",
      { status: SeedCoverageStatus.Skipped, reason: "Retry queue only." },
    ],
    ["todo", { status: SeedCoverageStatus.Todo }],
  ])("accepts %s", (_label, entry) => {
    expect(parseSeedCoverageContents(JSON.stringify(entry))).toEqual({
      valid: true,
      entry,
    });
  });

  it.each([
    ["an unknown status", { status: "partial" }],
    ["seeded without a stage", { status: SeedCoverageStatus.Seeded }],
    [
      "seeded with a blank stage",
      { status: SeedCoverageStatus.Seeded, stage: "  " },
    ],
    ["skipped without a reason", { status: SeedCoverageStatus.Skipped }],
    [
      "skipped with a blank reason",
      { status: SeedCoverageStatus.Skipped, reason: "" },
    ],
    [
      "a reason on a seeded file",
      { status: SeedCoverageStatus.Seeded, stage: "core", reason: "x" },
    ],
    [
      "a reason on a todo file",
      { status: SeedCoverageStatus.Todo, reason: "x" },
    ],
    ["a stage on a todo file", { status: SeedCoverageStatus.Todo, stage: "x" }],
    ["an array", [{ status: SeedCoverageStatus.Todo }]],
  ])("rejects %s", (_label, value) => {
    expect(parseSeedCoverageContents(JSON.stringify(value)).valid).toBe(false);
  });

  it("reports malformed JSON as invalid instead of throwing", () => {
    const record = parseSeedCoverageContents("{ status: todo");
    expect(record.valid).toBe(false);
    expect(record.valid ? "" : record.problem).toContain("not valid JSON");
  });
});

describe("parseSeedCoverageDirectory", () => {
  it("keys each .json file by model name and ignores other files", () => {
    const files: Record<string, string> = {
      "Beta.json": JSON.stringify({ status: SeedCoverageStatus.Todo }),
      "Alpha.json": JSON.stringify({
        status: SeedCoverageStatus.Seeded,
        stage: "core",
      }),
      "README.md": "# not a coverage file",
    };
    const coverage = parseSeedCoverageDirectory(
      Object.keys(files),
      (fileName) => files[fileName] ?? ""
    );

    expect([...coverage.keys()]).toEqual(["Alpha", "Beta"]);
    expect(coverage.get("Alpha")).toEqual({
      valid: true,
      entry: { status: SeedCoverageStatus.Seeded, stage: "core" },
    });
    expect(coverage.get("Beta")).toEqual({
      valid: true,
      entry: { status: SeedCoverageStatus.Todo },
    });
  });
});

describe("compareCoverage", () => {
  const seeded: SeedCoverageRecord = {
    valid: true,
    entry: { status: SeedCoverageStatus.Seeded, stage: "core" },
  };
  const todo: SeedCoverageRecord = {
    valid: true,
    entry: { status: SeedCoverageStatus.Todo },
  };
  const invalid: SeedCoverageRecord = {
    valid: false,
    problem: "status: Invalid input",
  };

  it("is clean when both models have valid, non-todo files", () => {
    const coverage: SeedCoverage = new Map<string, SeedCoverageRecord>([
      ["Alpha", seeded],
      ["Beta", seeded],
    ]);
    expect(compareCoverage(["Alpha", "Beta"], coverage)).toEqual({
      missing: [],
      stale: [],
      invalid: [],
      todo: [],
    });
  });

  it("reports only the model that has no file as missing", () => {
    const coverage: SeedCoverage = new Map<string, SeedCoverageRecord>([
      ["Alpha", seeded],
    ]);
    expect(compareCoverage(["Alpha", "Beta"], coverage).missing).toEqual([
      "Beta",
    ]);
  });

  it("reports only the file whose model is gone as stale", () => {
    const coverage: SeedCoverage = new Map<string, SeedCoverageRecord>([
      ["Alpha", seeded],
      ["Beta", seeded],
      ["Gone", seeded],
    ]);
    const comparison = compareCoverage(["Alpha", "Beta"], coverage);
    expect(comparison.stale).toEqual(["Gone"]);
    expect(comparison.missing).toEqual([]);
  });

  it("reports only the invalid file, with its problem", () => {
    const coverage: SeedCoverage = new Map<string, SeedCoverageRecord>([
      ["Alpha", seeded],
      ["Beta", invalid],
    ]);
    expect(compareCoverage(["Alpha", "Beta"], coverage).invalid).toEqual([
      { model: "Beta", problem: "status: Invalid input" },
    ]);
  });

  it("reports only the todo model as todo", () => {
    const coverage: SeedCoverage = new Map<string, SeedCoverageRecord>([
      ["Alpha", todo],
      ["Beta", seeded],
    ]);
    const comparison = compareCoverage(["Alpha", "Beta"], coverage);
    expect(comparison.todo).toEqual(["Alpha"]);
    expect(comparison.invalid).toEqual([]);
  });

  it("reports a stale invalid file as stale, not invalid", () => {
    const coverage: SeedCoverage = new Map<string, SeedCoverageRecord>([
      ["Alpha", seeded],
      ["Beta", seeded],
      ["Gone", invalid],
    ]);
    const comparison = compareCoverage(["Alpha", "Beta"], coverage);
    expect(comparison.stale).toEqual(["Gone"]);
    expect(comparison.invalid).toEqual([]);
  });
});

describe("failure messages", () => {
  it("names the file to add for each missing model", () => {
    const message = describeMissingSeedCoverage(
      ["Alpha", "Beta"],
      COVERAGE_DIR
    );
    expect(message).toContain(
      `Add ${COVERAGE_DIR}/Alpha.json with {"status":"todo"}`
    );
    expect(message).toContain(
      `Add ${COVERAGE_DIR}/Beta.json with {"status":"todo"}`
    );
  });

  it("names the file to delete for each stale model", () => {
    expect(describeStaleSeedCoverage(["Gone"], COVERAGE_DIR)).toContain(
      `Delete ${COVERAGE_DIR}/Gone.json`
    );
  });

  it("names the file to fix and why", () => {
    expect(
      describeInvalidSeedCoverage(
        [{ model: "Beta", problem: "stage: Required" }],
        COVERAGE_DIR
      )
    ).toContain(`Fix ${COVERAGE_DIR}/Beta.json: stage: Required.`);
  });
});
