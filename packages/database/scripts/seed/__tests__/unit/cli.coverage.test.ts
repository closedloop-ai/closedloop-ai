import { describe, expect, it } from "vitest";
import {
  evaluateSeedGuards,
  parseSeedCliArgs,
  SeedGuardFailureReason,
} from "../../cli";
import { SeedProfileName } from "../../profiles";

describe("seed cli parser — uncovered branches", () => {
  it("surfaces an invalid --scale-multiplier before target validation", () => {
    const result = parseSeedCliArgs(["--scale-multiplier", "not-a-number"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.InvalidMultiplier);
    }
  });

  it("rejects a --scale-multiplier that would scale a target past MAX_SAFE_SEED_TARGET", () => {
    const result = parseSeedCliArgs([
      "--profile",
      SeedProfileName.Minimal,
      "--scale-multiplier",
      "2000000",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.InvalidMultiplier);
      expect(result.message).toContain("unsafe target above");
    }
  });

  it("rejects an invalid --user-id UUID even when --organization-id is valid", () => {
    const result = parseSeedCliArgs([
      "--organization-id",
      "019e703d-c4ef-7718-9d1e-83b30048692b",
      "--user-id",
      "not-a-uuid",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.InvalidTargetUuid);
      expect(result.message).toBe("--user-id must be a UUID.");
    }
  });
});

describe("evaluateSeedGuards — uncovered branches", () => {
  it("refuses a run with no DATABASE_URL at all", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: undefined,
      pgHost: undefined,
      stagePgHost: undefined,
      seedAllowRemote: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.MissingDatabaseUrl);
    }
  });

  it("reports an unresolvable target host when DATABASE_URL has no hostname and no PGHOST is set", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql:///dbname",
      pgHost: undefined,
      stagePgHost: undefined,
      seedAllowRemote: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.TargetHostUnknown);
    }
  });

  it("blocks a production-shaped PGHOST even when DATABASE_URL carries no host to compare it against", () => {
    // pins current behavior: an empty DATABASE_URL host makes the earlier
    // canonicalDatabaseHost checks (production-pattern and PGHOST-mismatch)
    // no-ops, so a production-shaped PGHOST is only caught by the later
    // canonicalTargetHost check.
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql:///dbname",
      pgHost: "db.production.example.test",
      stagePgHost: undefined,
      seedAllowRemote: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.ProductionHostBlocked);
      expect(result.message).toContain("from PGHOST");
    }
  });

  it("requires STAGE_PGHOST to be configured for a non-localhost perf target", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Perf,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@remote.example.test:5432/app",
      pgHost: undefined,
      stagePgHost: undefined,
      seedAllowRemote: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.StageHostUnconfigured);
    }
  });

  it("accepts a non-localhost perf target that does not match the configured shared-stage host", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Perf,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@not-the-stage.example.test:5432/app",
      pgHost: undefined,
      stagePgHost: "stage.example.test",
      seedAllowRemote: "1",
    });
    expect(result.ok).toBe(true);
  });

  it("recognizes a bracketed IPv6 host literal as localhost", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@[::1]:5432/app",
      pgHost: undefined,
      stagePgHost: undefined,
      seedAllowRemote: undefined,
    });
    expect(result.ok).toBe(true);
  });
});
