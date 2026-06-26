import { describe, expect, it } from "vitest";
import {
  getSeedTargetRanges,
  resolveSeedRunPlan,
  SEED_PROFILES,
  SeedProfileName,
  SeedRngMode,
  SeedTransactionMode,
  scaleSeedTargets,
} from "../../profiles";

describe("seed profiles", () => {
  it("defines the required baseline targets", () => {
    expect(SEED_PROFILES[SeedProfileName.Minimal]).toEqual({
      projects: 1,
      artifacts: 10,
      comments: 20,
      loops: 5,
    });
    expect(SEED_PROFILES[SeedProfileName.Local]).toEqual({
      projects: 8,
      artifacts: 60,
      comments: 150,
      loops: 45,
    });
    expect(SEED_PROFILES[SeedProfileName.E2e]).toEqual({
      projects: 3,
      artifacts: 24,
      comments: 48,
      loops: 12,
    });
    expect(SEED_PROFILES[SeedProfileName.CiPreview]).toEqual({
      projects: 10,
      artifacts: 100,
      comments: 500,
      loops: 75,
    });
    expect(SEED_PROFILES[SeedProfileName.Perf]).toEqual({
      projects: 100,
      artifacts: 8000,
      comments: 75_000,
      loops: 1500,
    });
  });

  it("rounds scaled targets and computes +/-20 percent ranges", () => {
    const scaled = scaleSeedTargets(
      SEED_PROFILES[SeedProfileName.Minimal],
      2.4
    );
    expect(scaled).toEqual({
      projects: 2,
      artifacts: 24,
      comments: 48,
      loops: 12,
    });
    expect(getSeedTargetRanges({ ...scaled, projects: 10 }).projects).toEqual({
      min: 8,
      max: 12,
    });
  });

  it("selects fixed RNG for non-perf and batched perf strategy", () => {
    expect(resolveSeedRunPlan().rngMode).toBe(SeedRngMode.Fixed);
    const perfPlan = resolveSeedRunPlan({ profile: SeedProfileName.Perf });
    expect(perfPlan.rngMode).toBe(SeedRngMode.Perf);
    expect(perfPlan.transaction.mode).toBe(SeedTransactionMode.Batched);
  });
});
