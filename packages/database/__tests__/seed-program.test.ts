import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSslOption } from "../scripts/db-utils";
import {
  buildPreviewSeedInvocation,
  PREVIEW_SEED_ARGS,
  PREVIEW_SEED_CLI_ARGS,
  previewSeedEnv,
  runPreviewSeedInProcess,
} from "../scripts/preview-seed";
import { runSeedProgram } from "../scripts/seed/program";

/*
 * ISS-6804. `runSeedProgram` is the seed CLI as a function; these cases drive
 * it the way the `/preview-schemas/seed` route does — argv and env as
 * ARGUMENTS — and pin two contracts without a database:
 *
 * 1. Every exit the CLI used to make is a returned exit code, with the same
 *    message, and nothing is read from `process.env` (the route composes the
 *    env for one request; a global read would leak another request's).
 * 2. The preview seed's arguments and environment are one definition shared by
 *    the `pnpm` spawn (the build) and the in-process runner (the function), so
 *    the two paths cannot drift.
 *
 * A guard failure returns before any connection is opened, and the one case
 * that does open one points at a port nothing listens on, so it fails fast and
 * deterministically. `PGHOST` is set on every env because a developer shell may
 * carry one, and the guard compares it against the URL host.
 */

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const LOCAL_URL = "postgresql://user:placeholder@127.0.0.1:1/cl";
const PREVIEW_SCHEMA = "preview_feat_x_0a1b2c3d";
/** Prisma's wording for a refused connection (P1001 through `$queryRaw`). */
const UNREACHABLE_DATABASE = /Can't reach database server at 127\.0\.0\.1:1/u;

afterEach(() => {
  vi.unstubAllEnvs();
  quiet.log.mockClear();
  quiet.warn.mockClear();
  quiet.error.mockClear();
});

describe("runSeedProgram — exit codes without a database", () => {
  it("returns 0 for --help without touching anything", async () => {
    const result = await runSeedProgram({
      argv: ["--help"],
      env: {},
      logger: quiet,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(quiet.log).toHaveBeenCalled();
  });

  it("returns 1 with the guard's message when DATABASE_URL is missing", async () => {
    const result = await runSeedProgram({
      argv: [...PREVIEW_SEED_CLI_ARGS],
      env: {},
      logger: quiet,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("DATABASE_URL");
  });

  it("reads env from its ARGUMENT, never from process.env", async () => {
    // A valid-looking URL on the process must not rescue an env that lacks one.
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    vi.stubEnv("SEED_ALLOW_REMOTE", "1");

    const result = await runSeedProgram({
      argv: [...PREVIEW_SEED_CLI_ARGS],
      env: {},
      logger: quiet,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("DATABASE_URL");
  });

  it("refuses a production-shaped host", async () => {
    const result = await runSeedProgram({
      argv: [...PREVIEW_SEED_CLI_ARGS],
      env: {
        DATABASE_URL:
          "postgresql://user:placeholder@cl-ai-prod-db.example.test:5432/app",
        PGHOST: "cl-ai-prod-db.example.test",
        SEED_ALLOW_REMOTE: "1",
      },
      logger: quiet,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("production");
  });

  it("refuses a remote host without SEED_ALLOW_REMOTE=1", async () => {
    const result = await runSeedProgram({
      argv: [...PREVIEW_SEED_CLI_ARGS],
      env: {
        DATABASE_URL: "postgresql://user:placeholder@db.example.test:5432/app",
        PGHOST: "db.example.test",
      },
      logger: quiet,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("SEED_ALLOW_REMOTE");
  });

  it("returns 1, never rejects, when the database cannot be reached", async () => {
    const result = await runSeedProgram({
      argv: [...PREVIEW_SEED_CLI_ARGS],
      env: {
        DATABASE_URL: LOCAL_URL,
        PGHOST: "127.0.0.1",
        PGSCHEMA: PREVIEW_SCHEMA,
      },
      logger: quiet,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(UNREACHABLE_DATABASE);
  }, 30_000);
});

describe("preview seed — one definition for the spawn and the in-process run", () => {
  it("the spawn's seed arguments are exactly the in-process arguments", () => {
    const afterSeparator = PREVIEW_SEED_ARGS.slice(
      PREVIEW_SEED_ARGS.indexOf("--") + 1
    );

    expect(afterSeparator).toEqual([...PREVIEW_SEED_CLI_ARGS]);
    expect(PREVIEW_SEED_CLI_ARGS).toEqual([
      "--profile",
      "ci-preview",
      "--bootstrap-user",
    ]);
  });

  it("the spawn's env IS previewSeedEnv", () => {
    const base = { KEEP: "me", PGHOST: "db.example.test" };
    const url = `postgresql://u:placeholder@db.example.test:5432/app?schema=${PREVIEW_SCHEMA}&sslmode=require`;

    const invocation = buildPreviewSeedInvocation(url, PREVIEW_SCHEMA, base);
    const env = previewSeedEnv(url, PREVIEW_SCHEMA, base);

    expect(invocation.env).toEqual(env);
    expect(env.KEEP).toBe("me");
    // Authoritative schema: stripped from the DSN, carried by PGSCHEMA.
    expect(env.DATABASE_URL).not.toContain("schema=");
    expect(env.DATABASE_URL).toContain("sslmode=require");
    expect(env.PGSCHEMA).toBe(PREVIEW_SCHEMA);
    expect(env.SEED_ALLOW_REMOTE).toBe("1");
    // Verified TLS: the IAM database token never rides an unverified chain.
    expect(env.ALLOW_INSECURE_SSL).toBeUndefined();
  });

  it("never forces insecure TLS, and resolves to the verified RDS path", () => {
    const url = `postgresql://u:placeholder@db.rds.amazonaws.com:5432/app?sslmode=require&schema=${PREVIEW_SCHEMA}`;
    const env = previewSeedEnv(url, PREVIEW_SCHEMA, {
      ALLOW_INSECURE_SSL: undefined,
    });

    expect(env.ALLOW_INSECURE_SSL).toBeUndefined();
    // The env this builds is what program.ts feeds resolveSslOption, so assert
    // the actual TLS decision rather than only the absence of the flag.
    const ssl = resolveSslOption({
      isLocalhost: false,
      sslmode: "require",
      allowInsecure: env.ALLOW_INSECURE_SSL === "1",
    });
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    expect((ssl as { ca?: string[] }).ca?.length).toBeGreaterThan(0);
  });

  it("in-process: refuses anything that is not a preview schema, before any I/O", async () => {
    for (const schema of [null, "public", "preview", "staging_x"]) {
      const result = await runPreviewSeedInProcess(
        LOCAL_URL,
        schema,
        {},
        quiet
      );
      expect(result).toEqual({ ran: false, reason: "not_a_preview_schema" });
    }
    expect(quiet.log).not.toHaveBeenCalled();
  });

  it("in-process: runs the real program with the shared args/env and reports failure as data", async () => {
    // Localhost target so the remote guard is not what fails; port 1 so the
    // connection is refused — the failure the route would answer 500 with.
    const result = await runPreviewSeedInProcess(
      LOCAL_URL,
      PREVIEW_SCHEMA,
      { PGHOST: "127.0.0.1" },
      quiet
    );

    expect(result.ran).toBe(true);
    if (!result.ran) {
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(UNREACHABLE_DATABASE);
    expect(quiet.warn).toHaveBeenCalledWith(
      expect.stringContaining("Preview seed failed (non-blocking)")
    );
  }, 30_000);
});
