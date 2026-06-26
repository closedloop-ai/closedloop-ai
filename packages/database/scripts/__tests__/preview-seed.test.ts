import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildPreviewSeedInvocation,
  DEFAULT_PREVIEW_SEED_TIMEOUT_MS,
  describePreviewSeedFailure,
  PREVIEW_SEED_ARGS,
  PREVIEW_SEED_MAX_BUFFER_BYTES,
  runPreviewSeed,
} from "../preview-seed";

const PREVIEW_SCHEMA = "preview_feature_branch_abc123";
const DATABASE_URL_WITH_SCHEMA =
  "postgresql://user:pass@db.example.com:5432/closedloop?schema=public&sslmode=require";

function makeResult(
  overrides: Partial<SpawnSyncReturns<string>>
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

describe("buildPreviewSeedInvocation", () => {
  it("strips ?schema= from the URL and pins the schema via PGSCHEMA (authoritative schema)", () => {
    const invocation = buildPreviewSeedInvocation(
      DATABASE_URL_WITH_SCHEMA,
      PREVIEW_SCHEMA,
      {}
    );

    expect(invocation.env.DATABASE_URL).not.toContain("schema=");
    expect(invocation.env.DATABASE_URL).toContain("sslmode=require");
    expect(invocation.env.PGSCHEMA).toBe(PREVIEW_SCHEMA);
    expect(invocation.env.SEED_ALLOW_REMOTE).toBe("1");
    // FEA-1786: the seed must connect to RDS with relaxed TLS verification
    // (rejectUnauthorized: false), matching index.ts/migrate — otherwise it
    // dies on the RDS self-signed cert chain. A localhost integration test can't
    // exercise the RDS-TLS path, so guard it at the invocation-env level.
    expect(invocation.env.ALLOW_INSECURE_SSL).toBe("1");
    expect(invocation.command).toBe("pnpm");
    expect(invocation.args).toEqual([...PREVIEW_SEED_ARGS]);
  });

  it("defaults the timeout and honors PREVIEW_SEED_TIMEOUT_MS override", () => {
    expect(
      buildPreviewSeedInvocation(DATABASE_URL_WITH_SCHEMA, PREVIEW_SCHEMA, {})
        .timeoutMs
    ).toBe(DEFAULT_PREVIEW_SEED_TIMEOUT_MS);

    expect(
      buildPreviewSeedInvocation(DATABASE_URL_WITH_SCHEMA, PREVIEW_SCHEMA, {
        PREVIEW_SEED_TIMEOUT_MS: "1000",
      }).timeoutMs
    ).toBe(1000);

    // Invalid override falls back to the default rather than 0/NaN.
    expect(
      buildPreviewSeedInvocation(DATABASE_URL_WITH_SCHEMA, PREVIEW_SCHEMA, {
        PREVIEW_SEED_TIMEOUT_MS: "not-a-number",
      }).timeoutMs
    ).toBe(DEFAULT_PREVIEW_SEED_TIMEOUT_MS);
  });
});

describe("describePreviewSeedFailure", () => {
  it("returns null on success (status 0, no error)", () => {
    expect(
      describePreviewSeedFailure(makeResult({ status: 0 }), 5000)
    ).toBeNull();
  });

  it("classifies an ETIMEDOUT error as a timeout", () => {
    const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    expect(
      describePreviewSeedFailure(
        makeResult({ error, signal: "SIGTERM", status: null }),
        5000
      )
    ).toBe("timed out after 5000ms");
  });

  it("classifies an ENOBUFS SIGTERM kill as a failure (not a timeout), with the code", () => {
    const error = Object.assign(new Error("maxBuffer exceeded"), {
      code: "ENOBUFS",
    });
    expect(
      describePreviewSeedFailure(
        makeResult({ error, signal: "SIGTERM", status: null }),
        7000
      )
    ).toBe("failed (ENOBUFS): maxBuffer exceeded");
  });

  it("classifies a non-zero exit as a failure", () => {
    expect(describePreviewSeedFailure(makeResult({ status: 1 }), 5000)).toBe(
      "failed with exit code 1"
    );
  });

  it("classifies a spawn error as a failure", () => {
    expect(
      describePreviewSeedFailure(
        makeResult({ error: new Error("ENOENT"), status: null }),
        5000
      )
    ).toBe("failed: ENOENT");
  });
});

describe("runPreviewSeed", () => {
  it("is a no-op for non-preview schemas", () => {
    const spawnSyncFn = vi.fn();
    for (const schema of [null, "public", "staging"]) {
      runPreviewSeed(DATABASE_URL_WITH_SCHEMA, schema, { spawnSyncFn });
    }
    expect(spawnSyncFn).not.toHaveBeenCalled();
  });

  it("spawns the seed for a preview schema with authoritative schema env", () => {
    const spawnSyncFn = vi.fn().mockReturnValue(makeResult({ status: 0 }));
    const logger = makeLogger();

    runPreviewSeed(DATABASE_URL_WITH_SCHEMA, PREVIEW_SCHEMA, {
      spawnSyncFn,
      logger,
    });

    expect(spawnSyncFn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSyncFn.mock.calls[0];
    expect(command).toBe("pnpm");
    expect(args).toEqual([...PREVIEW_SEED_ARGS]);
    expect(options.env.PGSCHEMA).toBe(PREVIEW_SCHEMA);
    expect(options.env.DATABASE_URL).not.toContain("schema=");
    expect(options.timeout).toBe(DEFAULT_PREVIEW_SEED_TIMEOUT_MS);
    expect(options.maxBuffer).toBe(PREVIEW_SEED_MAX_BUFFER_BYTES);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns non-blockingly on a timeout", () => {
    const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const spawnSyncFn = vi
      .fn()
      .mockReturnValue(makeResult({ error, signal: "SIGTERM", status: null }));
    const logger = makeLogger();

    expect(() =>
      runPreviewSeed(DATABASE_URL_WITH_SCHEMA, PREVIEW_SCHEMA, {
        spawnSyncFn,
        logger,
      })
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("timed out")
    );
  });

  it("warns non-blockingly on a non-zero exit", () => {
    const spawnSyncFn = vi.fn().mockReturnValue(makeResult({ status: 2 }));
    const logger = makeLogger();

    runPreviewSeed(DATABASE_URL_WITH_SCHEMA, PREVIEW_SCHEMA, {
      spawnSyncFn,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed with exit code 2")
    );
  });
});
