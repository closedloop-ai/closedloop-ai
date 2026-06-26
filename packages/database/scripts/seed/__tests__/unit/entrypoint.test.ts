import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as GeneratedClientModule from "../../../../generated/client";
import { SeedGuardFailureReason } from "../../cli";
import type * as OrgGuardModule from "../../non-empty-org-guard";
import { SeedProfileName } from "../../profiles";
import type * as SeedResetModule from "../../reset";
import { SEED_DB_TEST_TIMEOUT_MS } from "../timeouts";

const entrypointMocks = vi.hoisted(() => ({
  collectResetVerificationSnapshot: vi.fn(),
  confirmResetIfNeeded: vi.fn(),
  countResettableOrgRows: vi.fn(),
  detectOrgConflicts: vi.fn(),
  poolEnd: vi.fn(),
  pool: vi.fn(function Pool() {
    return { end: entrypointMocks.poolEnd };
  }),
  prismaDisconnect: vi.fn(),
  prismaClient: vi.fn(function PrismaClient() {
    return { $disconnect: entrypointMocks.prismaDisconnect };
  }),
  prismaPg: vi.fn(),
  resetOrgData: vi.fn(),
  runSeed: vi.fn(),
  verifyResetComplete: vi.fn(),
}));

// Toggles that make the generated client / seed phase-graph mocks throw at
// import time, simulating the build-environment module-resolution failure that
// caused the 2026-06-05 api-stage deploy failure. Reset in afterEach.
const importFailureFlags = vi.hoisted(() => ({
  failSeedModule: false,
}));

vi.mock("pg", () => ({
  default: { Pool: entrypointMocks.pool },
  Pool: entrypointMocks.pool,
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: entrypointMocks.prismaPg,
}));

vi.mock("../../../../generated/client", async (importOriginal) => {
  const actual = await importOriginal<typeof GeneratedClientModule>();
  return {
    ...actual,
    PrismaClient: entrypointMocks.prismaClient,
  };
});

vi.mock("../../index", () => {
  if (importFailureFlags.failSeedModule) {
    throw new Error(
      "E_TEST_UNRESOLVABLE_SEED_MODULE: simulated seed phase-graph load failure"
    );
  }
  return { runSeed: entrypointMocks.runSeed };
});

vi.mock("../../non-empty-org-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof OrgGuardModule>();
  return {
    ...actual,
    detectOrgConflicts: entrypointMocks.detectOrgConflicts,
  };
});

vi.mock("../../reset", async (importOriginal) => {
  const actual = await importOriginal<typeof SeedResetModule>();
  return {
    ...actual,
    collectResetVerificationSnapshot:
      entrypointMocks.collectResetVerificationSnapshot,
    countResettableOrgRows: entrypointMocks.countResettableOrgRows,
    resetOrgData: entrypointMocks.resetOrgData,
    verifyResetComplete: entrypointMocks.verifyResetComplete,
  };
});

vi.mock("../../reset-confirmation", () => ({
  confirmResetIfNeeded: entrypointMocks.confirmResetIfNeeded,
}));

const COMMAND_TIMEOUT_MS = 60_000;
const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../.."
);
const DATABASE_PACKAGE_DIR = path.join(WORKSPACE_ROOT, "packages/database");
const DB_ACCESS_SIGNALS = [
  "Initializing PrismaClient",
  "Resolving user and organization",
  "Reset summary",
  "Seed complete",
] as const;
const ENV_KEYS = [
  "DATABASE_URL",
  "PGHOST",
  "STAGE_PGHOST",
  "SEED_ALLOW_REMOTE",
  "SEED_RESET_ALLOW_REMOTE",
  "SEED_FORCE_OVERWRITE",
] as const;

describe("seed entrypoint guard order", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    importFailureFlags.failSeedModule = false;
    for (const mock of Object.values(entrypointMocks)) {
      mock.mockReset();
    }
  });

  it.each([
    {
      name: "invalid profile before no-reset DB initialization",
      args: ["--profile", "unknown-profile"],
      env: {
        DATABASE_URL: "postgresql://user:pass@cl-ai-prod.example.test:5432/app",
      },
      reason: SeedGuardFailureReason.InvalidProfile,
    },
    {
      name: "invalid reset target UUID before DB initialization",
      args: ["--reset", "--force", "--organization-id", "not-a-uuid"],
      env: {
        DATABASE_URL: "postgresql://user:pass@cl-ai-prod.example.test:5432/app",
      },
      reason: SeedGuardFailureReason.InvalidTargetUuid,
    },
    {
      name: "missing DATABASE_URL before reset DB initialization",
      args: ["--reset", "--force", "--profile", SeedProfileName.Minimal],
      env: {},
      reason: SeedGuardFailureReason.MissingDatabaseUrl,
    },
    {
      name: "production DATABASE_URL despite local PGHOST before reset DB initialization",
      args: ["--reset", "--force", "--profile", SeedProfileName.Minimal],
      env: {
        DATABASE_URL: "postgresql://user:pass@cl-ai-prod.example.test:5432/app",
        PGHOST: "localhost",
        SEED_ALLOW_REMOTE: "1",
      },
      reason: SeedGuardFailureReason.ProductionHostBlocked,
    },
    {
      name: "PGHOST and DATABASE_URL mismatch before no-reset DB initialization",
      args: ["--profile", SeedProfileName.Minimal],
      env: {
        DATABASE_URL: "postgresql://user:pass@preview.example.test:5432/app",
        PGHOST: "localhost",
        SEED_ALLOW_REMOTE: "1",
      },
      reason: SeedGuardFailureReason.TargetHostMismatch,
    },
    {
      name: "remote host without opt-in before reset DB initialization",
      args: ["--reset", "--force", "--profile", SeedProfileName.Minimal],
      env: {
        DATABASE_URL: "postgresql://user:pass@preview.example.test:5432/app",
      },
      reason: SeedGuardFailureReason.RemoteHostRequiresOptIn,
    },
    {
      name: "remote reset blocked even with SEED_ALLOW_REMOTE=1 and --force",
      args: ["--reset", "--force", "--profile", SeedProfileName.Minimal],
      env: {
        DATABASE_URL: "postgresql://user:pass@preview.example.test:5432/app",
        SEED_ALLOW_REMOTE: "1",
      },
      reason: SeedGuardFailureReason.RemoteResetRequiresExplicitOptIn,
    },
    {
      name: "shared-stage perf guard before no-reset DB initialization",
      args: ["--profile", SeedProfileName.Perf],
      env: {
        DATABASE_URL: "postgresql://user:pass@stage.example.test:5432/app",
        STAGE_PGHOST: "STAGE.example.test",
        SEED_ALLOW_REMOTE: "1",
      },
      reason: SeedGuardFailureReason.SharedStageBlocked,
    },
  ])(
    "$name",
    ({ args, env, reason }) => {
      const result = runSeedCommand(args, env as Record<string, string>);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain(reason);
      for (const signal of DB_ACCESS_SIGNALS) {
        expect(output).not.toContain(signal);
      }
    },
    SEED_DB_TEST_TIMEOUT_MS
  );

  it.each([
    {
      name: "invalid no-reset profile",
      argv: ["--profile", "unknown-profile"],
      env: {
        DATABASE_URL: "postgresql://user:pass@cl-ai-prod.example.test:5432/app",
      },
      reason: SeedGuardFailureReason.InvalidProfile,
    },
    {
      name: "reset target parser failure",
      argv: ["--reset", "--force", "--organization-id", "not-a-uuid"],
      env: {
        DATABASE_URL: "postgresql://user:pass@cl-ai-prod.example.test:5432/app",
      },
      reason: SeedGuardFailureReason.InvalidTargetUuid,
    },
    {
      name: "reset guard failure",
      argv: ["--reset", "--force", "--profile", SeedProfileName.Minimal],
      env: {
        DATABASE_URL: "postgresql://user:pass@preview.example.test:5432/app",
      },
      reason: SeedGuardFailureReason.RemoteHostRequiresOptIn,
    },
  ])("does not initialize DB or seed helpers before $name", async ({
    argv,
    env,
    reason,
  }) => {
    const restoreEnv = replaceSeedEnv(env);
    const originalArgv = process.argv;
    process.argv = ["node", "seed.ts", ...argv];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null | undefined
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    const stderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const exitRejection = new Promise<unknown>((resolve) => {
        process.once("unhandledRejection", resolve);
      });
      await import("../../../seed");
      await expect(exitRejection).resolves.toMatchObject({
        message: "process.exit:1",
      });
      expect(stderrSpy.mock.calls.flat().map(String).join("\n")).toContain(
        reason
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(entrypointMocks.pool).not.toHaveBeenCalled();
      expect(entrypointMocks.prismaPg).not.toHaveBeenCalled();
      expect(entrypointMocks.prismaClient).not.toHaveBeenCalled();
      expect(entrypointMocks.detectOrgConflicts).not.toHaveBeenCalled();
      expect(
        entrypointMocks.collectResetVerificationSnapshot
      ).not.toHaveBeenCalled();
      expect(entrypointMocks.countResettableOrgRows).not.toHaveBeenCalled();
      expect(entrypointMocks.confirmResetIfNeeded).not.toHaveBeenCalled();
      expect(entrypointMocks.resetOrgData).not.toHaveBeenCalled();
      expect(entrypointMocks.verifyResetComplete).not.toHaveBeenCalled();
      expect(entrypointMocks.runSeed).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      restoreEnv();
    }
  });

  it("aborts before any reset/delete side effect when the seed phase graph fails to load", async () => {
    // Regression guard for shafty023's review: the seed phase modules (which
    // value-import the generated client) must load AFTER the guards but BEFORE
    // any destructive reset, so a load failure can never leave a `--reset`
    // target wiped-but-not-reseeded. A localhost --reset passes the guards; the
    // phase-graph import then fails, and the reset helpers must never run.
    importFailureFlags.failSeedModule = true;
    vi.resetModules();
    const restoreEnv = replaceSeedEnv({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
    });
    const originalArgv = process.argv;
    process.argv = [
      "node",
      "seed.ts",
      "--reset",
      "--force",
      "--profile",
      SeedProfileName.Minimal,
    ];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null | undefined
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    const stderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const exitRejection = new Promise<unknown>((resolve) => {
        process.once("unhandledRejection", resolve);
      });
      await import("../../../seed");
      await expect(exitRejection).resolves.toMatchObject({
        message: "process.exit:1",
      });
      // Guards passed: the first error is the main() catch ("❌ Seed failed"),
      // not a guard reason — so the failure is the post-guard phase-graph import,
      // which (per the fix) runs before `new PrismaClient`, the org preflight,
      // and any reset/delete.
      const firstError = stderrSpy.mock.calls[0]?.map(String).join(" ") ?? "";
      expect(firstError).toContain("❌ Seed failed");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(entrypointMocks.prismaClient).not.toHaveBeenCalled();
      expect(entrypointMocks.detectOrgConflicts).not.toHaveBeenCalled();
      // The destructive reset path must never have executed.
      expect(entrypointMocks.resetOrgData).not.toHaveBeenCalled();
      expect(entrypointMocks.verifyResetComplete).not.toHaveBeenCalled();
      expect(
        entrypointMocks.collectResetVerificationSnapshot
      ).not.toHaveBeenCalled();
      expect(entrypointMocks.runSeed).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      restoreEnv();
    }
  });
});

function runSeedCommand(
  args: readonly string[],
  envOverrides: Record<string, string>
) {
  const env = { ...process.env, ...envOverrides };
  for (const key of [
    "DATABASE_URL",
    "PGHOST",
    "STAGE_PGHOST",
    "SEED_ALLOW_REMOTE",
    "SEED_RESET_ALLOW_REMOTE",
    "SEED_FORCE_OVERWRITE",
  ]) {
    if (!(key in envOverrides)) {
      Reflect.deleteProperty(env, key);
    }
  }
  return spawnSync("pnpm", ["seed", "--", ...args], {
    cwd: DATABASE_PACKAGE_DIR,
    env,
    encoding: "utf-8",
    timeout: COMMAND_TIMEOUT_MS,
  });
}

function replaceSeedEnv(envOverrides: Record<string, string>) {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );
  for (const key of ENV_KEYS) {
    if (key in envOverrides) {
      process.env[key] = envOverrides[key];
    } else {
      Reflect.deleteProperty(process.env, key);
    }
  }
  return () => {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  };
}
