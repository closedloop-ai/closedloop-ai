/**
 * ISS-12017: the vibe seed accepts only a local `control_*` database, and
 * refuses everything else before it creates any database client. `withDb` and
 * the identity writer are mocked at their module boundaries so the suite can
 * prove neither was reached on a refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  ensureSeedIdentity: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: mocks.withDb };
});
vi.mock("../vibe-seed/core/local-trusted-identity", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../vibe-seed/core/local-trusted-identity")
    >();
  return {
    ...actual,
    ensureSeedIdentity: mocks.ensureSeedIdentity,
  };
});

import { E2E_LOCAL_TRUSTED_ORG_ID_ENV } from "@repo/auth/auth-mode";
import ConnectionParameters from "pg/lib/connection-parameters";
import { checkVibeDatabaseUrl, VibeSeedRefusalCode } from "../vibe-seed/guards";
import { runVibeSeed } from "../vibe-seed/run";

const ACCEPTED_URLS = [
  "postgresql://postgres:postgres@localhost:5432/control_wp2_abc123",
  "postgresql://postgres:postgres@127.0.0.1:5432/control_vibe_0f0f0f?schema=public",
] as const;

const REFUSED_URLS = [
  {
    url: "",
    code: VibeSeedRefusalCode.DatabaseUrlMissing,
  },
  {
    url: "not a url",
    code: VibeSeedRefusalCode.DatabaseUrlUnparseable,
  },
  {
    url: "postgresql://postgres:postgres@db.example.com:5432/control_wp2_abc123",
    code: VibeSeedRefusalCode.DatabaseUrlNotLocal,
  },
  {
    url: "postgresql://postgres:postgres@[::1]:5432/control_wp2_abc123",
    code: VibeSeedRefusalCode.DatabaseUrlNotLocal,
  },
  {
    url: "postgresql://postgres:postgres@localhost:5432/control_wp2_abc123?host=remote.example",
    code: VibeSeedRefusalCode.DatabaseUrlRedirected,
  },
  {
    url: "postgresql://postgres:postgres@localhost:5432/control_wp2_abc123?hostaddr=10.0.0.5",
    code: VibeSeedRefusalCode.DatabaseUrlRedirected,
  },
  {
    url: "postgresql://postgres:postgres@localhost:5432/control_wp2_abc123?port=6543",
    code: VibeSeedRefusalCode.DatabaseUrlRedirected,
  },
  {
    url: "postgresql://postgres:postgres@localhost:5432/control_wp2_abc123?schema=public&h%6Fst=remote.example",
    code: VibeSeedRefusalCode.DatabaseUrlRedirected,
  },
  {
    url: "postgresql://postgres:postgres@%2Fvar%2Frun%2Fpostgresql/control_wp2_abc123",
    code: VibeSeedRefusalCode.DatabaseUrlNotLocal,
  },
  {
    url: "socket:/var/run/postgresql?db=control_wp2_abc123",
    code: VibeSeedRefusalCode.DatabaseUrlNotLocal,
  },
  {
    url: "postgresql://postgres:postgres@localhost:5432/closedloop_ai",
    code: VibeSeedRefusalCode.DatabaseNotThrowaway,
  },
  {
    url: "postgresql://postgres:postgres@localhost:5432/closedloop_perf",
    code: VibeSeedRefusalCode.DatabaseNotThrowaway,
  },
  {
    url: "postgresql://postgres:postgres@localhost:5432/my_control_db",
    code: VibeSeedRefusalCode.DatabaseNotThrowaway,
  },
] as const;

describe("checkVibeDatabaseUrl", () => {
  it.each(ACCEPTED_URLS)("accepts the local control_ database %s", (url) => {
    const result = checkVibeDatabaseUrl(url);
    expect(result.ok).toBe(true);
  });

  it.each(REFUSED_URLS)("refuses '$url' as $code", ({ url, code }) => {
    const result = checkVibeDatabaseUrl(url);
    expect(result).toStrictEqual({
      ok: false,
      error: { code, message: expect.any(String) },
    });
  });
});

describe("checkVibeDatabaseUrl against pg's own parse", () => {
  const REDIRECTED =
    "postgresql://postgres:postgres@localhost:5432/control_wp2_abc123?host=remote.example";

  it("refuses the query host pg would actually connect to", () => {
    expect(new ConnectionParameters(REDIRECTED).host).toBe("remote.example");
    expect(checkVibeDatabaseUrl(REDIRECTED).ok).toBe(false);
  });

  it("accepts only what pg resolves to a local control_ database", () => {
    for (const url of ACCEPTED_URLS) {
      const parameters = new ConnectionParameters(url);
      expect(parameters.host).toBe(new URL(url).hostname);
      expect(parameters.database?.startsWith("control_")).toBe(true);
    }
  });
});

describe("runVibeSeed refusals", () => {
  let previousDatabaseUrl: string | undefined;
  let previousOrgOverride: string | undefined;

  beforeEach(() => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousOrgOverride = process.env[E2E_LOCAL_TRUSTED_ORG_ID_ENV];
    Reflect.deleteProperty(process.env, E2E_LOCAL_TRUSTED_ORG_ID_ENV);
  });

  afterEach(() => {
    restoreEnv("DATABASE_URL", previousDatabaseUrl);
    restoreEnv(E2E_LOCAL_TRUSTED_ORG_ID_ENV, previousOrgOverride);
  });

  it.each(REFUSED_URLS)(
    "refuses $code before any database client or identity write",
    async ({ url, code }) => {
      const summary = await runVibeSeed({
        databaseUrl: url,
        desktopStorePath: null,
        desktopAuth: null,
        apiKeyOutPath: null,
        skipBase: false,
      });

      expect(summary.ok).toBe(false);
      expect(summary.error?.startsWith(`${code}: `)).toBe(true);
      expect(summary.rowCounts).toStrictEqual({});
      expect(mocks.withDb).not.toHaveBeenCalled();
      expect(mocks.ensureSeedIdentity).not.toHaveBeenCalled();
      expect(process.env.DATABASE_URL).toBe(previousDatabaseUrl);
    }
  );

  it("refuses an identity override the vibe stack does not set", async () => {
    process.env[E2E_LOCAL_TRUSTED_ORG_ID_ENV] = "org_someone_else";
    const summary = await runVibeSeed({
      databaseUrl: ACCEPTED_URLS[0],
      desktopStorePath: null,
      desktopAuth: null,
      apiKeyOutPath: null,
      skipBase: false,
    });

    expect(
      summary.error?.startsWith(
        `${VibeSeedRefusalCode.LocalTrustedOverrideSet}: `
      )
    ).toBe(true);
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.ensureSeedIdentity).not.toHaveBeenCalled();
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}
