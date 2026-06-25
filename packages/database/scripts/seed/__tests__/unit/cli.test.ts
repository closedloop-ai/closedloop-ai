import { describe, expect, it } from "vitest";
import { isLocalhostUrl } from "../../../db-utils";
import {
  evaluateSeedGuards,
  parseScaleMultiplier,
  parseSeedCliArgs,
  resolveSeedTargetHost,
  SeedGuardFailureReason,
} from "../../cli";
import { SeedProfileName } from "../../profiles";

describe("seed cli parser", () => {
  it("defaults to the local profile", () => {
    const result = parseSeedCliArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.profile).toBe(SeedProfileName.Local);
      expect(result.options.multiplier).toBe(1);
      expect(result.options.reset).toEqual({ requested: false, force: false });
      expect(result.options.target).toEqual({});
    }
  });

  it("parses reset, force, target, and profile flags through the shared contract", () => {
    const result = parseSeedCliArgs([
      "--reset",
      "--force",
      "--profile",
      "minimal",
      "--scale-multiplier",
      "2",
      "--rng-seed",
      "reset-test",
      "--organization-id",
      "019e703d-c4ef-7718-9d1e-83b30048692b",
      "--user-id",
      "019e703d-c4ef-7718-9d1e-83b30048692c",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.profile).toBe(SeedProfileName.Minimal);
      expect(result.options.multiplier).toBe(2);
      expect(result.options.rngSeed).toBe("reset-test");
      expect(result.options.reset).toEqual({ requested: true, force: true });
      expect(result.options.target).toEqual({
        organizationId: "019e703d-c4ef-7718-9d1e-83b30048692b",
        userId: "019e703d-c4ef-7718-9d1e-83b30048692c",
      });
    }
  });

  it("accepts the leading -- separator pnpm forwards to script argv", () => {
    const result = parseSeedCliArgs(["--", "--reset", "--force"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.reset).toEqual({ requested: true, force: true });
    }
  });

  it("rejects wrong reset-like flags and invalid target UUIDs before DB access", () => {
    const wrongFlag = parseSeedCliArgs(["--resett"]);
    expect(wrongFlag.ok).toBe(false);
    if (!wrongFlag.ok) {
      expect(wrongFlag.reason).toBe(SeedGuardFailureReason.InvalidCliArgs);
    }

    const invalidOrg = parseSeedCliArgs(["--reset", "--organization-id", "no"]);
    expect(invalidOrg.ok).toBe(false);
    if (!invalidOrg.ok) {
      expect(invalidOrg.reason).toBe(SeedGuardFailureReason.InvalidTargetUuid);
    }
  });

  it("returns help text without accepting positional arguments", () => {
    const help = parseSeedCliArgs(["--help"]);
    expect(help.ok).toBe(false);
    if (!help.ok) {
      expect(help.reason).toBe(SeedGuardFailureReason.HelpRequested);
      expect(help.helpText).toContain("--reset");
    }

    const positional = parseSeedCliArgs(["reset"]);
    expect(positional.ok).toBe(false);
    if (!positional.ok) {
      expect(positional.reason).toBe(SeedGuardFailureReason.InvalidCliArgs);
    }
  });

  it("does not echo secret-like parser values in failure messages", () => {
    const secretUrl =
      "postgresql://user:password@example.test:5432/app?token=secret";
    const positional = parseSeedCliArgs([secretUrl]);
    expect(positional.ok).toBe(false);
    if (!positional.ok) {
      expect(positional.reason).toBe(SeedGuardFailureReason.InvalidCliArgs);
      expect(positional.message).not.toContain(secretUrl);
      expect(positional.message).not.toContain("password");
      expect(positional.message).not.toContain("secret");
    }

    const invalidProfile = parseSeedCliArgs(["--profile", secretUrl]);
    expect(invalidProfile.ok).toBe(false);
    if (!invalidProfile.ok) {
      expect(invalidProfile.reason).toBe(SeedGuardFailureReason.InvalidProfile);
      expect(invalidProfile.message).not.toContain(secretUrl);
      expect(invalidProfile.message).not.toContain("password");
      expect(invalidProfile.message).not.toContain("secret");
    }
  });

  it("accepts exact valid profile names and rejects similar names", () => {
    expect(parseSeedCliArgs(["--profile", "ci-preview"]).ok).toBe(true);
    const result = parseSeedCliArgs(["--profile", "cipreview"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.InvalidProfile);
      expect(result.validProfiles).toContain(SeedProfileName.CiPreview);
    }
  });

  it("rejects invalid multiplier values before DB access", () => {
    const invalidValues = ["", " ", "abc", "NaN", "Infinity", "1e9999", "0.5"];
    for (const value of invalidValues) {
      const result = parseScaleMultiplier(value, SeedProfileName.Local);
      expect(result.ok, value).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(SeedGuardFailureReason.InvalidMultiplier);
      }
    }
  });

  it("warns but accepts finite multipliers above 10", () => {
    const result = parseScaleMultiplier("11", SeedProfileName.Minimal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.multiplier).toBe(11);
    }
  });
});

describe("seed guard evaluation", () => {
  const databaseUrl = "postgresql://user:pass@localhost:5432/app?token=secret";

  it("uses non-empty PGHOST before DATABASE_URL host", () => {
    const result = resolveSeedTargetHost({
      databaseUrl,
      pgHost: "stage.example.test",
    });
    expect(result).toEqual({
      ok: true,
      targetHost: "stage.example.test",
      source: "PGHOST",
    });
  });

  it("ignores empty PGHOST and falls back to DATABASE_URL host", () => {
    const result = resolveSeedTargetHost({ databaseUrl, pgHost: " " });
    expect(result).toEqual({
      ok: true,
      targetHost: "localhost",
      source: "DATABASE_URL",
    });
  });

  it("blocks production-shaped DATABASE_URL even when PGHOST is local", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@cl-ai-prod.example.test:5432/app",
      pgHost: "localhost",
      stagePgHost: undefined,
      seedAllowRemote: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.ProductionHostBlocked);
    }
  });

  it("fails closed when PGHOST and DATABASE_URL host diverge", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@preview.example.test:5432/app",
      pgHost: "localhost",
      stagePgHost: undefined,
      seedAllowRemote: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.TargetHostMismatch);
    }
  });

  it("accepts case-insensitive PGHOST and DATABASE_URL host matches", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@localhost:5432/app",
      pgHost: "LOCALHOST",
      stagePgHost: undefined,
      seedAllowRemote: undefined,
    });
    expect(result.ok).toBe(true);
  });

  it("normalizes accepted PGHOST values before localhost SSL checks", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@localhost:5432/app",
      pgHost: "LOCALHOST",
      stagePgHost: undefined,
      seedAllowRemote: undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const urlForLocalhostCheck = new URL(result.url.toString());
      urlForLocalhostCheck.hostname = result.targetHost.toLowerCase();
      expect(isLocalhostUrl(urlForLocalhostCheck)).toBe(true);
    }
  });

  it("requires remote opt-in before DB construction", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@preview.example.test:5432/app",
      pgHost: undefined,
      stagePgHost: undefined,
      seedAllowRemote: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        SeedGuardFailureReason.RemoteHostRequiresOptIn
      );
    }
  });

  it("blocks perf on configured shared stage without explicit override", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Perf,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@stage.example.test:5432/app",
      pgHost: undefined,
      stagePgHost: "stage.example.test",
      seedAllowRemote: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.SharedStageBlocked);
    }
  });

  it("blocks shared stage with case-insensitive host equality", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Perf,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@stage.example.test:5432/app",
      pgHost: "STAGE.example.test",
      stagePgHost: "stage.EXAMPLE.test",
      seedAllowRemote: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.SharedStageBlocked);
    }
  });

  it("matches configured shared stage hosts after DNS canonicalization", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Perf,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@stage.example.test.:5432/app",
      pgHost: undefined,
      stagePgHost: "stage.example.test",
      seedAllowRemote: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.SharedStageBlocked);
    }
  });

  it("blocks --reset --force against a remote host even with SEED_ALLOW_REMOTE=1", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@preview.example.test:5432/app",
      pgHost: undefined,
      stagePgHost: undefined,
      seedAllowRemote: "1",
      resetRequested: true,
      seedResetAllowRemote: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        SeedGuardFailureReason.RemoteResetRequiresExplicitOptIn
      );
    }
  });

  it("allows --reset against a remote host only when SEED_RESET_ALLOW_REMOTE=1", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@preview.example.test:5432/app",
      pgHost: undefined,
      stagePgHost: undefined,
      seedAllowRemote: "1",
      resetRequested: true,
      seedResetAllowRemote: "1",
    });
    expect(result.ok).toBe(true);
  });

  it("does not require SEED_RESET_ALLOW_REMOTE on localhost reset", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@localhost:5432/app",
      pgHost: undefined,
      stagePgHost: undefined,
      seedAllowRemote: undefined,
      resetRequested: true,
      seedResetAllowRemote: undefined,
    });
    expect(result.ok).toBe(true);
  });

  it("keeps production block ahead of the remote-reset opt-in", () => {
    const result = evaluateSeedGuards({
      profile: SeedProfileName.Local,
      allowSharedStage: false,
      databaseUrl: "postgresql://user:pass@cl-ai-prod.example.test:5432/app",
      pgHost: undefined,
      stagePgHost: undefined,
      seedAllowRemote: "1",
      resetRequested: true,
      seedResetAllowRemote: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(SeedGuardFailureReason.ProductionHostBlocked);
    }
  });
});
