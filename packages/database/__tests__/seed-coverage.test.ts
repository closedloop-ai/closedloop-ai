/**
 * ISS-12017: every web Prisma model declares whether the local seed fills it,
 * in one JSON file per model under prisma/seeds/coverage (see its README.md).
 * The model list comes from the generated client, never from schema text.
 */
import {
  compareCoverage,
  describeInvalidSeedCoverage,
  describeMissingSeedCoverage,
  describeStaleSeedCoverage,
} from "@repo/api/src/seed-coverage";
import { describe, expect, it } from "vitest";
import { Prisma } from "../generated/browser";
import {
  loadWebSeedCoverage,
  WEB_SEED_COVERAGE_DIR_LABEL,
} from "../scripts/seed/coverage";

const modelNames = Object.values(Prisma.ModelName);
const comparison = compareCoverage(modelNames, loadWebSeedCoverage());

describe("web seed coverage", () => {
  it("reads a non-empty model list from the generated client", () => {
    expect(modelNames.length).toBeGreaterThan(0);
  });

  it("has a coverage file for every Prisma model", () => {
    expect(
      comparison.missing,
      describeMissingSeedCoverage(
        comparison.missing,
        WEB_SEED_COVERAGE_DIR_LABEL
      )
    ).toEqual([]);
  });

  it("has no coverage file for a model the schema does not have", () => {
    expect(
      comparison.stale,
      describeStaleSeedCoverage(comparison.stale, WEB_SEED_COVERAGE_DIR_LABEL)
    ).toEqual([]);
  });

  it("has only valid coverage files", () => {
    expect(
      comparison.invalid,
      describeInvalidSeedCoverage(
        comparison.invalid,
        WEB_SEED_COVERAGE_DIR_LABEL
      )
    ).toEqual([]);
  });
});
