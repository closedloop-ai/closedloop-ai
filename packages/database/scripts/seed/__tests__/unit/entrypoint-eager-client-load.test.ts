import { afterEach, describe, expect, it, vi } from "vitest";

// Dedicated regression guard for the 2026-06-05 api-stage deploy failure: the
// seed entrypoint's CLI-parse + production-guard path MUST NOT import the
// generated Prisma client. The client is mocked to throw on import; a malformed
// invocation must still be rejected by the guard with its reason. If any
// guard-path module (seed.ts, cli.ts, profiles.ts, …) re-adds a static
// value-import of the client, importing seed.ts throws here and this test fails
// — catching exactly the silent regression thadeusb flagged in review.
//
// This file deliberately does NOT statically import cli.ts/profiles.ts, so they
// load fresh under the throwing client mock (vitest caches a module's mocked
// result once loaded, which would otherwise mask a guard-path regression).

const runSeed = vi.fn();

vi.mock("../../../../generated/client", () => {
  throw new Error(
    "E_TEST_UNRESOLVABLE_CLIENT: generated client must not load on the guard path"
  );
});
vi.mock("../../index", () => ({ runSeed }));

const SEED_ENV_KEYS = [
  "DATABASE_URL",
  "PGHOST",
  "STAGE_PGHOST",
  "SEED_ALLOW_REMOTE",
  "SEED_RESET_ALLOW_REMOTE",
  "SEED_FORCE_OVERWRITE",
] as const;

describe("seed entrypoint guard path never loads the generated client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    runSeed.mockReset();
  });

  it("rejects an invalid profile without importing the generated client", async () => {
    const previousEnv = Object.fromEntries(
      SEED_ENV_KEYS.map((k) => [k, process.env[k]])
    );
    for (const k of SEED_ENV_KEYS) {
      Reflect.deleteProperty(process.env, k);
    }
    process.env.DATABASE_URL =
      "postgresql://user:pass@cl-ai-prod.example.test:5432/app";
    const originalArgv = process.argv;
    process.argv = ["node", "seed.ts", "--profile", "unknown-profile"];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null | undefined
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    const errSpy = vi
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
      const stderr = errSpy.mock.calls.flat().map(String).join("\n");
      expect(stderr).toContain("invalid_profile");
      expect(stderr).not.toContain("E_TEST_UNRESOLVABLE_CLIENT");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(runSeed).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      for (const k of SEED_ENV_KEYS) {
        const v = previousEnv[k];
        if (v === undefined) {
          Reflect.deleteProperty(process.env, k);
        } else {
          process.env[k] = v;
        }
      }
    }
  });
});
