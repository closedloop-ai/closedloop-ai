/**
 * `withMigratorClient` — the connection the preview-schema DROP runs on since
 * ISS-5978 moved it off the runtime pool.
 *
 * The contract is WHICH identity it connects as. On Vercel that is the IAM
 * migrator user (`MIGRATE_PGUSER`, falling back to `PGUSER`), so token signing
 * is the only thing stubbed: the env read that picks the user is the real one
 * the DROP uses in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateSqlClient, mockMintedFor } = vi.hoisted(() => ({
  mockCreateSqlClient: vi.fn(),
  mockMintedFor: vi.fn(),
}));

// Only the token SIGNING is stubbed (it needs live AWS credentials); the env
// read that decides the user, `readIamAuthConfig`, is the real one.
vi.mock("@repo/database/scripts/iam-database-url", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/database/scripts/iam-database-url")
    >();
  return {
    ...actual,
    // The signed URL resolves THROUGH `mockMintedFor`, so a test can stall the
    // mint the way a hung STS resolution would; returning nothing (the default)
    // mints immediately.
    createSchemaUrlMinter:
      (config: { user: string; host: string; database: string }) =>
      (schema: string | null) =>
        Promise.resolve(mockMintedFor(config.user, schema)).then(
          () =>
            `postgresql://${config.user}:signed-token@${config.host}:5432/${config.database}?sslmode=require`
        ),
  };
});

vi.mock("@repo/database/scripts/db-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database/scripts/db-utils")>()),
  createSqlClient: mockCreateSqlClient,
}));

import {
  MIGRATOR_NOT_CONFIGURED_MESSAGE,
  withMigratorClient,
} from "@/app/preview-schemas/service/migrator-connection";

const IAM_ENV = {
  NODE_ENV: "test",
  AWS_ROLE_ARN: "arn:aws:iam::1:role/vercel",
  AWS_REGION: "us-east-1",
  PGHOST: "stage.rds.amazonaws.com",
  PGUSER: "vercel_iam",
  MIGRATE_PGUSER: "vercel_migrator",
  PGDATABASE: "app",
} satisfies NodeJS.ProcessEnv;

const LOCAL_DATABASE_URL = "postgresql://dev:dev@localhost:5432/app";

/** `withTimeout`'s message, whatever the ceiling is set to. */
const TIMED_OUT_MESSAGE = /timed out after \d+ms/;

type FakeClient = {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

let client: FakeClient;

beforeEach(() => {
  client = {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  mockCreateSqlClient.mockReturnValue(client);
});

afterEach(() => {
  // Unconditional: a case that throws between `useFakeTimers` and its own
  // restore would otherwise leak a frozen clock into every later test here.
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("withMigratorClient", () => {
  it("connects as MIGRATE_PGUSER over verified TLS, not as the runtime PGUSER", async () => {
    await withMigratorClient(() => Promise.resolve(), { ...IAM_ENV });

    expect(mockMintedFor).toHaveBeenCalledWith("vercel_migrator", null);
    const [url, opts] = mockCreateSqlClient.mock.calls[0] ?? [];
    expect(new URL(String(url)).username).toBe("vercel_migrator");
    expect(opts).toEqual(expect.objectContaining({ allowInsecure: false }));
  });

  // The ceiling `withDb.tx`'s 40 s transaction timeout used to give the DROP.
  it("bounds every query on the connection from the client side", async () => {
    await withMigratorClient(() => Promise.resolve(), { ...IAM_ENV });

    const [, opts] = mockCreateSqlClient.mock.calls[0] ?? [];
    expect(opts).toEqual(
      expect.objectContaining({
        connectionTimeoutMillis: expect.any(Number),
        queryTimeoutMillis: expect.any(Number),
      })
    );
  });

  it("uses DATABASE_URL only where no IAM config exists, still over verified TLS", async () => {
    await withMigratorClient(() => Promise.resolve(), {
      NODE_ENV: "test",
      DATABASE_URL: LOCAL_DATABASE_URL,
    });

    expect(mockMintedFor).not.toHaveBeenCalled();
    expect(mockCreateSqlClient).toHaveBeenCalledWith(
      LOCAL_DATABASE_URL,
      expect.objectContaining({ allowInsecure: false })
    );
  });

  // ISS-9122: an ECS task sets neither AWS_ROLE_ARN nor VERCEL_ENV, and signs
  // through its task role. The DROP must connect there, not refuse.
  it("connects as MIGRATE_PGUSER on the ECS task-role shape, with no AWS_ROLE_ARN", async () => {
    const { AWS_ROLE_ARN: _unset, ...ecsTaskEnv } = IAM_ENV;

    await withMigratorClient(() => Promise.resolve(), ecsTaskEnv);

    expect(mockMintedFor).toHaveBeenCalledWith("vercel_migrator", null);
    const [url] = mockCreateSqlClient.mock.calls[0] ?? [];
    expect(new URL(String(url)).username).toBe("vercel_migrator");
  });

  it("prefers the IAM migrator over DATABASE_URL when both are present", async () => {
    await withMigratorClient(() => Promise.resolve(), {
      ...IAM_ENV,
      DATABASE_URL: LOCAL_DATABASE_URL,
    });

    const [url] = mockCreateSqlClient.mock.calls[0] ?? [];
    expect(new URL(String(url)).username).toBe("vercel_migrator");
  });

  it("refuses to run with no connection configured, opening nothing", async () => {
    const fn = vi.fn();

    await expect(withMigratorClient(fn, { NODE_ENV: "test" })).rejects.toThrow(
      MIGRATOR_NOT_CONFIGURED_MESSAGE
    );
    expect(mockCreateSqlClient).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("hands the connected client to the callback and closes it on failure", async () => {
    const failure = new Error("DROP failed");
    const handedTo = vi.fn((_connected: unknown) => Promise.reject(failure));

    await expect(withMigratorClient(handedTo, { ...IAM_ENV })).rejects.toBe(
      failure
    );
    expect(handedTo).toHaveBeenCalledWith(client);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
  });

  // On Vercel `DATABASE_URL` is the RUNTIME pool's URL — the `vercel_iam` role
  // ISS-5978 demotes — so one missing IAM variable has to name itself rather
  // than connect on the role that can no longer drop (42501 on every schema,
  // which reads as a privilege regression instead of a missing env var).
  it("refuses instead of falling back to DATABASE_URL on a Vercel deployment", async () => {
    const { PGHOST: _unset, ...incompleteIam } = IAM_ENV;

    await expect(
      withMigratorClient(vi.fn(), {
        ...incompleteIam,
        VERCEL_ENV: "production",
        DATABASE_URL: "postgresql://vercel_iam:pw@stage.rds.amazonaws.com/app",
      })
    ).rejects.toThrow(MIGRATOR_NOT_CONFIGURED_MESSAGE);
    expect(mockCreateSqlClient).not.toHaveBeenCalled();
  });

  // The whole call, not each step: the sweep's headroom under `maxDuration` is
  // sized against ONE bound on the in-flight drop, and the IAM token mint — a
  // fresh STS resolution per call — carries none of its own, so a stalled mint
  // must still be what the deadline fires on.
  it("bounds the whole call, mint included, not just the queries", async () => {
    vi.useFakeTimers();
    mockMintedFor.mockReturnValueOnce(
      new Promise(() => {
        // Never settles — a signing call that hangs.
      })
    );
    const fn = vi.fn();

    const settled = expect(
      withMigratorClient(fn, { ...IAM_ENV })
    ).rejects.toThrow(TIMED_OUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(120_000);
    await settled;

    expect(mockMintedFor).toHaveBeenCalledOnce();
    expect(mockCreateSqlClient).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});
