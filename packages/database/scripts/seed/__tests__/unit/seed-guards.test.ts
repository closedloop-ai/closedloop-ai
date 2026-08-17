import { describe, expect, it } from "vitest";
import {
  canonicalizeSeedHost,
  evaluateSeedGuards,
  resolveSeedTargetHost,
  SeedGuardFailureReason,
} from "../../cli";
import { SeedProfileName } from "../../profiles";

/**
 * The production-seed guards — the code that stands between `pnpm seed` and
 * someone's real database.
 *
 * `scripts/seed/__tests__/unit/cli.test.ts` already covers the happy paths and
 * the common refusals. This file closes the remaining branches, which are the
 * ones a reviewer would most want pinned: host canonicalization (the step every
 * later comparison depends on), the PGHOST-vs-DATABASE_URL mismatch, and the
 * two-key opt-in that a destructive `--reset` needs on a remote target.
 */

const LOCAL_URL = "postgresql://user:pass@localhost:5432/db";
const REMOTE_URL = "postgresql://user:pass@db.internal.example:5432/db";

const guards = (over: Partial<Parameters<typeof evaluateSeedGuards>[0]> = {}) =>
  evaluateSeedGuards({
    profile: SeedProfileName.Local,
    allowSharedStage: false,
    databaseUrl: LOCAL_URL,
    pgHost: undefined,
    stagePgHost: undefined,
    seedAllowRemote: undefined,
    ...over,
  });

describe("canonicalizeSeedHost", () => {
  it("lowercases and trims", () => {
    expect(canonicalizeSeedHost("  DB.Example.COM  ")).toBe("db.example.com");
  });

  it("unwraps a bracketed IPv6 literal", () => {
    // A URL hostname keeps the brackets; every later comparison is against a
    // bare host, so they have to come off or nothing matches.
    expect(canonicalizeSeedHost("[::1]")).toBe("::1");
  });

  it("strips trailing dots from a fully-qualified name", () => {
    // "db.example.com." and "db.example.com" are the same host; leaving the
    // root dot on would defeat the production-pattern match.
    expect(canonicalizeSeedHost("db.example.com.")).toBe("db.example.com");
    expect(canonicalizeSeedHost("db.example.com...")).toBe("db.example.com");
  });

  it("returns an empty string for an empty host", () => {
    expect(canonicalizeSeedHost("")).toBe("");
    expect(canonicalizeSeedHost("   ")).toBe("");
  });
});

describe("resolveSeedTargetHost", () => {
  it("prefers PGHOST over the URL host", () => {
    expect(
      resolveSeedTargetHost({ databaseUrl: LOCAL_URL, pgHost: "  other.host " })
    ).toEqual({ ok: true, targetHost: "other.host", source: "PGHOST" });
  });

  it("ignores a blank PGHOST and falls back to the URL", () => {
    expect(
      resolveSeedTargetHost({ databaseUrl: LOCAL_URL, pgHost: "   " })
    ).toMatchObject({
      ok: true,
      targetHost: "localhost",
      source: "DATABASE_URL",
    });
  });

  it("fails when the URL cannot be parsed", () => {
    expect(
      resolveSeedTargetHost({ databaseUrl: "not a url", pgHost: undefined })
    ).toMatchObject({ ok: false });
  });
});

describe("evaluateSeedGuards — connection preconditions", () => {
  it("refuses without a DATABASE_URL", () => {
    expect(guards({ databaseUrl: undefined })).toMatchObject({
      ok: false,
      reason: SeedGuardFailureReason.MissingDatabaseUrl,
    });
  });

  it("refuses an unparseable DATABASE_URL", () => {
    expect(guards({ databaseUrl: "not a url" })).toMatchObject({
      ok: false,
      reason: SeedGuardFailureReason.InvalidDatabaseUrl,
    });
  });

  it("allows a localhost target with no opt-in", () => {
    expect(guards()).toMatchObject({ ok: true, targetHost: "localhost" });
  });
});

describe("evaluateSeedGuards — PGHOST must agree with DATABASE_URL", () => {
  it("refuses when PGHOST names a different host", () => {
    // The two are separate inputs, and disagreeing means the operator's intent
    // is ambiguous — which host would you be wiping?
    expect(
      guards({ databaseUrl: LOCAL_URL, pgHost: "elsewhere.example" })
    ).toMatchObject({
      ok: false,
      reason: SeedGuardFailureReason.TargetHostMismatch,
    });
  });

  it("accepts a PGHOST that matches once canonicalized", () => {
    // Trailing dot and case differ, but it is the same host.
    expect(
      guards({ databaseUrl: LOCAL_URL, pgHost: "LOCALHOST." })
    ).toMatchObject({ ok: true });
  });
});

describe("evaluateSeedGuards — remote targets", () => {
  it("refuses a non-localhost target without SEED_ALLOW_REMOTE", () => {
    expect(guards({ databaseUrl: REMOTE_URL })).toMatchObject({
      ok: false,
      reason: SeedGuardFailureReason.RemoteHostRequiresOptIn,
    });
  });

  it("allows a non-localhost target with SEED_ALLOW_REMOTE=1", () => {
    expect(
      guards({ databaseUrl: REMOTE_URL, seedAllowRemote: "1" })
    ).toMatchObject({ ok: true });
  });

  it("treats any value other than exactly '1' as not opted in", () => {
    for (const value of ["true", "yes", "0", ""]) {
      expect(
        guards({ databaseUrl: REMOTE_URL, seedAllowRemote: value })
      ).toMatchObject({
        ok: false,
        reason: SeedGuardFailureReason.RemoteHostRequiresOptIn,
      });
    }
  });
});

describe("evaluateSeedGuards — destructive reset needs its OWN opt-in", () => {
  it("refuses a remote --reset even when SEED_ALLOW_REMOTE is set", () => {
    // This is the whole point of the second key: `--reset --force` skips the
    // only interactive confirmation, so the flag that merely permits seeding a
    // remote host must not also permit wiping it.
    expect(
      guards({
        databaseUrl: REMOTE_URL,
        seedAllowRemote: "1",
        resetRequested: true,
      })
    ).toMatchObject({
      ok: false,
      reason: SeedGuardFailureReason.RemoteResetRequiresExplicitOptIn,
    });
  });

  it("allows a remote --reset when BOTH keys are set", () => {
    expect(
      guards({
        databaseUrl: REMOTE_URL,
        seedAllowRemote: "1",
        resetRequested: true,
        seedResetAllowRemote: "1",
      })
    ).toMatchObject({ ok: true });
  });

  it("does not require the reset key for a localhost --reset", () => {
    expect(guards({ resetRequested: true })).toMatchObject({ ok: true });
  });

  it("treats any value other than exactly '1' as not opted in", () => {
    expect(
      guards({
        databaseUrl: REMOTE_URL,
        seedAllowRemote: "1",
        resetRequested: true,
        seedResetAllowRemote: "true",
      })
    ).toMatchObject({
      ok: false,
      reason: SeedGuardFailureReason.RemoteResetRequiresExplicitOptIn,
    });
  });
});

describe("evaluateSeedGuards — perf profile and shared stage", () => {
  it("refuses the perf profile when STAGE_PGHOST is unconfigured", () => {
    expect(
      guards({
        profile: SeedProfileName.Perf,
        databaseUrl: REMOTE_URL,
        seedAllowRemote: "1",
      })
    ).toMatchObject({
      ok: false,
      reason: SeedGuardFailureReason.StageHostUnconfigured,
    });
  });

  it("refuses a perf seed against the configured shared stage host", () => {
    expect(
      guards({
        profile: SeedProfileName.Perf,
        databaseUrl: REMOTE_URL,
        seedAllowRemote: "1",
        stagePgHost: "db.internal.example",
      })
    ).toMatchObject({
      ok: false,
      reason: SeedGuardFailureReason.SharedStageBlocked,
    });
  });

  it("allows it with --allow-shared-stage", () => {
    expect(
      guards({
        profile: SeedProfileName.Perf,
        databaseUrl: REMOTE_URL,
        seedAllowRemote: "1",
        stagePgHost: "db.internal.example",
        allowSharedStage: true,
      })
    ).toMatchObject({ ok: true });
  });

  it("compares the stage host canonically, not literally", () => {
    // A trailing dot or different case in STAGE_PGHOST must not let a perf seed
    // slip past the shared-stage block.
    expect(
      guards({
        profile: SeedProfileName.Perf,
        databaseUrl: REMOTE_URL,
        seedAllowRemote: "1",
        stagePgHost: "DB.Internal.Example.",
      })
    ).toMatchObject({
      ok: false,
      reason: SeedGuardFailureReason.SharedStageBlocked,
    });
  });
});
