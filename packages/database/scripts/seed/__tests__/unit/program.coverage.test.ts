import { afterEach, describe, expect, it, vi } from "vitest";
import type * as BootstrapModule from "../../bootstrap";
import { SeedGuardFailureReason } from "../../cli";
import type * as NonEmptyOrgGuardModule from "../../non-empty-org-guard";
import { SeedOrgPreflightStatus } from "../../non-empty-org-guard";
import { runSeedProgram } from "../../program";
import type * as ResetModule from "../../reset";
import { SeedResetFailureReason } from "../../reset";

const DATABASE_URL = "postgresql://user:pass@localhost:5432/seed_test";

const mocks = vi.hoisted(() => ({
  poolEnd: vi.fn(() => Promise.resolve()),
  pool: vi.fn(function Pool() {
    return { end: mocks.poolEnd };
  }),
  prismaDisconnect: vi.fn(() => Promise.resolve()),
  prismaClient: vi.fn(function PrismaClient() {
    return {
      $disconnect: mocks.prismaDisconnect,
    };
  }),
  prismaPg: vi.fn(),
  runSeed: vi.fn(() => Promise.resolve()),
  seedCuratedCatalogItems: vi.fn(() => Promise.resolve()),
  ensureBootstrapUser: vi.fn(),
  resolveSeedConnectionTarget: vi.fn(
    (): {
      sslmode: string | undefined;
      targetSchema: string | null;
      searchPath: string | null;
    } => ({
      sslmode: undefined,
      targetSchema: null,
      searchPath: null,
    })
  ),
  detectOrgConflicts: vi.fn(() =>
    Promise.resolve<{
      conflicts: string[];
      seedOwnedRows: string[];
      status: SeedOrgPreflightStatus;
    }>({
      conflicts: [],
      seedOwnedRows: [],
      status: SeedOrgPreflightStatus.Clean,
    })
  ),
  collectResetVerificationSnapshot: vi.fn(() => Promise.resolve({})),
  countResettableOrgRows: vi.fn(() => Promise.resolve({ totalRows: 0 })),
  confirmResetIfNeeded: vi.fn(() => Promise.resolve()),
  resetOrgData: vi.fn(() =>
    Promise.resolve<{
      modelCounts: { name: string; count: number }[];
      totalRows: number;
    }>({ modelCounts: [], totalRows: 0 })
  ),
  verifyResetComplete: vi.fn(() =>
    Promise.resolve<{
      ok: boolean;
      remaining?: { name: string; count: number }[];
    }>({ ok: true })
  ),
  assertEffectiveSchema: vi.fn(() => Promise.resolve()),
  resolveSeedTarget: vi.fn(
    (
      _prisma: unknown,
      _options: { organizationId?: string; userId?: string }
    ) =>
      Promise.resolve({
        organizationId: "00000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000002",
        userEmail: "seed-user@example.test",
        source: "legacy-default",
      })
  ),
}));

vi.mock("pg", () => ({
  default: { Pool: mocks.pool },
  Pool: mocks.pool,
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: mocks.prismaPg,
}));

vi.mock("../../../../generated/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../generated/client")>();
  return { ...actual, PrismaClient: mocks.prismaClient };
});

vi.mock("../../index", () => ({ runSeed: mocks.runSeed }));

vi.mock("../../curated-catalog", () => ({
  seedCuratedCatalogItems: mocks.seedCuratedCatalogItems,
}));

vi.mock("../../bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof BootstrapModule>();
  return { ...actual, ensureBootstrapUser: mocks.ensureBootstrapUser };
});

vi.mock("../../connection-target", () => ({
  resolveSeedConnectionTarget: mocks.resolveSeedConnectionTarget,
}));

vi.mock("../../non-empty-org-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof NonEmptyOrgGuardModule>();
  return { ...actual, detectOrgConflicts: mocks.detectOrgConflicts };
});

vi.mock("../../reset", async (importOriginal) => {
  const actual = await importOriginal<typeof ResetModule>();
  return {
    ...actual,
    collectResetVerificationSnapshot: mocks.collectResetVerificationSnapshot,
    countResettableOrgRows: mocks.countResettableOrgRows,
    resetOrgData: mocks.resetOrgData,
    verifyResetComplete: mocks.verifyResetComplete,
  };
});

vi.mock("../../reset-confirmation", () => ({
  confirmResetIfNeeded: mocks.confirmResetIfNeeded,
}));

vi.mock("../../schema-guard", () => ({
  assertEffectiveSchema: mocks.assertEffectiveSchema,
}));

vi.mock("../../target-resolution", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../target-resolution")>();
  return { ...actual, resolveSeedTarget: mocks.resolveSeedTarget };
});

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) {
    mock.mockClear();
  }
  mocks.detectOrgConflicts.mockResolvedValue({
    conflicts: [],
    seedOwnedRows: [],
    status: SeedOrgPreflightStatus.Clean,
  });
  mocks.verifyResetComplete.mockResolvedValue({ ok: true });
  mocks.resolveSeedConnectionTarget.mockReturnValue({
    sslmode: undefined,
    targetSchema: null,
    searchPath: null,
  });
  mocks.resolveSeedTarget.mockResolvedValue({
    organizationId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    userEmail: "seed-user@example.test",
    source: "legacy-default",
  });
});

describe("runSeedProgram — CLI parse short-circuits", () => {
  it("returns exitCode 0 and prints help text on --help, without ever touching the database", async () => {
    const logger = makeLogger();
    const result = await runSeedProgram({
      argv: ["--help"],
      env: {},
      logger,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(mocks.prismaClient).not.toHaveBeenCalled();
  });

  it("defaults to the global console when no logger is supplied", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await runSeedProgram({ argv: ["--help"], env: {} });

    expect(result).toEqual({ exitCode: 0 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("returns exitCode 1 with no helpText for a non-help parse failure", async () => {
    const logger = makeLogger();
    const result = await runSeedProgram({
      argv: ["--profile", "not-a-real-profile"],
      env: {},
      logger,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain(SeedGuardFailureReason.InvalidProfile);
    expect(logger.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Usage:")
    );
  });
});

describe("runSeedProgram — guard failure short-circuit", () => {
  it("returns exitCode 1 before any database work when DATABASE_URL is missing", async () => {
    const logger = makeLogger();
    const result = await runSeedProgram({
      argv: ["--profile", "minimal"],
      env: {},
      logger,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain(SeedGuardFailureReason.MissingDatabaseUrl);
    expect(mocks.prismaClient).not.toHaveBeenCalled();
  });
});

describe("runSeedProgram — non-Error throw from the outer catch", () => {
  it("stringifies a non-Error thrown value instead of reading .message", async () => {
    mocks.assertEffectiveSchema.mockRejectedValueOnce("a plain string throw");
    const logger = makeLogger();

    const result = await runSeedProgram({
      argv: ["--profile", "minimal"],
      env: { DATABASE_URL },
      logger,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("a plain string throw");
    expect(logger.error).toHaveBeenCalledWith(
      "❌ Seed failed: a plain string throw"
    );
  });
});

describe("runSeedProgram — bootstrap branch", () => {
  it("seeds into the identity ensureBootstrapUser created", async () => {
    const logger = makeLogger();
    mocks.resolveSeedConnectionTarget.mockReturnValue({
      sslmode: undefined,
      targetSchema: "seed_schema",
      searchPath: "seed_schema",
    });
    mocks.ensureBootstrapUser.mockResolvedValue({
      organizationId: "00000000-0000-4000-8000-000000000009",
      userId: "00000000-0000-4000-8000-00000000000a",
    });
    // Echo the requested identity so the assertion below pins what
    // applyBootstrapTarget handed to resolveSeedTarget, not a fixture default.
    mocks.resolveSeedTarget.mockImplementationOnce((_prisma, options) =>
      Promise.resolve({
        organizationId: options.organizationId ?? "",
        userId: options.userId ?? "",
        userEmail: "seed-user@example.test",
        source: "explicit-flags",
      })
    );

    const result = await runSeedProgram({
      argv: ["--profile", "minimal", "--bootstrap-user"],
      env: { DATABASE_URL },
      logger,
    });

    expect(result.exitCode).toBe(0);
    expect(mocks.ensureBootstrapUser).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSeedTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "00000000-0000-4000-8000-000000000009",
        userId: "00000000-0000-4000-8000-00000000000a",
      })
    );
    // A well-formed email redacts to only its domain half.
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("<redacted>@example.test")
    );
  });

  it("redacts a malformed email with no '@' to a bare marker", async () => {
    mocks.resolveSeedTarget.mockResolvedValue({
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      userEmail: "not-an-email",
      source: "legacy-default",
    });
    const logger = makeLogger();

    const result = await runSeedProgram({
      argv: ["--profile", "minimal"],
      env: { DATABASE_URL },
      logger,
    });

    expect(result.exitCode).toBe(0);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Resolved user: 00000000-0000-4000-8000-000000000002 (<redacted>)"
      )
    );
  });
});

describe("runSeedProgram — non-empty-org preflight", () => {
  it("refuses to seed a conflicted org without SEED_FORCE_OVERWRITE", async () => {
    mocks.detectOrgConflicts.mockResolvedValue({
      conflicts: ["GitHubInstallation has 1 row(s)"],
      seedOwnedRows: [],
      status: SeedOrgPreflightStatus.Conflicted,
    });
    const logger = makeLogger();

    const result = await runSeedProgram({
      argv: ["--profile", "minimal"],
      env: { DATABASE_URL },
      logger,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Refusing to seed");
    expect(mocks.runSeed).not.toHaveBeenCalled();
  });

  it("proceeds and warns when SEED_FORCE_OVERWRITE=1 overrides a conflicted org", async () => {
    mocks.detectOrgConflicts.mockResolvedValue({
      conflicts: ["GitHubInstallation has 1 row(s)"],
      seedOwnedRows: [],
      status: SeedOrgPreflightStatus.Conflicted,
    });
    const logger = makeLogger();

    const result = await runSeedProgram({
      argv: ["--profile", "minimal"],
      env: { DATABASE_URL, SEED_FORCE_OVERWRITE: "1" },
      logger,
    });

    expect(result.exitCode).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Seeding into non-empty org")
    );
    expect(mocks.runSeed).toHaveBeenCalledTimes(1);
  });

  it("logs idempotent-rerun notice when the org only has seed-owned rows", async () => {
    mocks.detectOrgConflicts.mockResolvedValue({
      conflicts: [],
      seedOwnedRows: ["Organization"],
      status: SeedOrgPreflightStatus.SeedOwned,
    });
    const logger = makeLogger();

    const result = await runSeedProgram({
      argv: ["--profile", "minimal"],
      env: { DATABASE_URL },
      logger,
    });

    expect(result.exitCode).toBe(0);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("Existing deterministic seed-owned rows detected")
    );
  });
});

describe("runSeedProgram — reset flow", () => {
  it("throws when reset verification finds rows still remaining", async () => {
    mocks.verifyResetComplete.mockResolvedValue({
      ok: false,
      remaining: [{ name: "Organization", count: 2 }],
    });
    const logger = makeLogger();

    const result = await runSeedProgram({
      argv: ["--profile", "minimal", "--reset", "--force"],
      env: { DATABASE_URL },
      logger,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain(
      SeedResetFailureReason.ResetVerificationFailed
    );
    expect(result.error).toContain("Organization=2");
    expect(mocks.detectOrgConflicts).not.toHaveBeenCalled();
  });

  it("completes the reset flow and logs the reset summary when verification passes", async () => {
    mocks.resetOrgData.mockResolvedValue({
      modelCounts: [{ name: "Organization", count: 1 }],
      totalRows: 1,
    });
    const logger = makeLogger();

    const result = await runSeedProgram({
      argv: ["--profile", "minimal", "--reset", "--force"],
      env: { DATABASE_URL },
      logger,
    });

    expect(result.exitCode).toBe(0);
    expect(mocks.confirmResetIfNeeded).toHaveBeenCalledTimes(1);
    expect(mocks.runSeed).toHaveBeenCalledTimes(1);
  });
});
