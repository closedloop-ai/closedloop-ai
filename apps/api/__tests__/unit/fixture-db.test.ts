/**
 * The fixture connection's resolution rule, which is what keeps the ISS-5978
 * two-role split OPT-IN: with no `MIGRATE_DATABASE_URL` every fixture in the
 * tier must land on exactly the connection it used before this module existed.
 */
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeOnSeedingConnection,
  asFixtureRawClient,
  type FixtureRawClient,
  fixtureDatabaseUrl,
  requireFixtureDatabaseUrl,
  withRolledBackFixtureTransaction,
} from "@/__tests__/utils/fixture-db";

// `pg` is stubbed rather than reached: the contract under test here is the
// statement ORDER the helper issues, which a real connection would not make
// any easier to observe.
const pgStub = vi.hoisted(() => ({
  queries: [] as string[],
  failOn: null as string | null,
}));
vi.mock("pg", () => ({
  Client: class {
    connect() {
      return Promise.resolve();
    }
    query(text: string) {
      pgStub.queries.push(text);
      if (pgStub.failOn === text) {
        return Promise.reject(new Error("ROLLBACK failed: connection lost"));
      }
      return Promise.resolve({ rows: [], rowCount: null });
    }
    end() {
      return Promise.resolve();
    }
  },
}));

const RUNTIME_URL = "postgresql://runtime@localhost:5432/app";
const MIGRATOR_URL = "postgresql://migrator@localhost:5432/app";
const AUDIT_LEDGER_PURPOSE = "the audit-ledger fixture";
// `ProcessEnv` requires `NODE_ENV` once `next typegen` has run, and this suite
// builds its environments as literals rather than mutating `process.env`.
const BASE_ENV = { NODE_ENV: "test" } as const;
const AUDIT_LEDGER_PURPOSE_RE = /the audit-ledger fixture/;
const SAME_HOST_AND_DATABASE_RE = /same host and database/;
const ROLLED_BACK_PURPOSE = "a rolled-back fixture transaction";
const COUNTERFACTUAL_RE = /counterfactual proved nothing/;
const ROLLBACK_FAILED_RE = /ROLLBACK failed/;
const SEEDED_TABLES = ["session_detail", "artifacts"] as const;
const SEED_PURPOSE = "a transaction-scoped planner corpus";
const UNOWNED_ARTIFACTS_RE = /does not own artifacts/;

type QueryCall = { query: string; values: unknown[] };

function fakeClient(
  result: { rows: unknown[]; rowCount: number | null },
  calls: QueryCall[]
): Client {
  return {
    query(query: string, values: unknown[]) {
      calls.push({ query, values });
      return Promise.resolve(result);
    },
  } as unknown as Client;
}

describe("fixtureDatabaseUrl", () => {
  it("prefers the migrator connection when one is configured", () => {
    expect(
      fixtureDatabaseUrl({
        ...BASE_ENV,
        DATABASE_URL: RUNTIME_URL,
        MIGRATE_DATABASE_URL: MIGRATOR_URL,
      })
    ).toBe(MIGRATOR_URL);
  });

  it("falls back to DATABASE_URL when no split is configured", () => {
    expect(fixtureDatabaseUrl({ ...BASE_ENV, DATABASE_URL: RUNTIME_URL })).toBe(
      RUNTIME_URL
    );
  });

  it("reads a blank migrator connection as unset, not as a connection", () => {
    // The `||`/`??` distinction, and the reason it is `||`: a `.env` file
    // carrying `MIGRATE_DATABASE_URL=` must behave like a commented-out line,
    // not send every fixture at the empty string.
    expect(
      fixtureDatabaseUrl({
        ...BASE_ENV,
        DATABASE_URL: RUNTIME_URL,
        MIGRATE_DATABASE_URL: "",
      })
    ).toBe(RUNTIME_URL);
  });

  it("resolves to nothing when neither is configured", () => {
    expect(fixtureDatabaseUrl({ ...BASE_ENV })).toBeUndefined();
  });
});

describe("requireFixtureDatabaseUrl", () => {
  it("names the caller in the error so a missing URL says whose fixture it was", () => {
    expect(() =>
      requireFixtureDatabaseUrl(AUDIT_LEDGER_PURPOSE, { ...BASE_ENV })
    ).toThrow(AUDIT_LEDGER_PURPOSE_RE);
  });

  it("returns the resolved connection when one is configured", () => {
    expect(
      requireFixtureDatabaseUrl("a fixture", {
        ...BASE_ENV,
        MIGRATE_DATABASE_URL: MIGRATOR_URL,
      })
    ).toBe(MIGRATOR_URL);
  });
});

describe("requireFixtureDatabaseUrl cluster guard", () => {
  it("refuses a migrator connection on a different host", () => {
    // The destructive half of what this connection carries — TRUNCATE, DROP
    // INDEX, VACUUM FULL — is why a typo here is refused rather than connected.
    expect(() =>
      requireFixtureDatabaseUrl("a fixture", {
        ...BASE_ENV,
        DATABASE_URL: RUNTIME_URL,
        MIGRATE_DATABASE_URL: "postgresql://migrator@elsewhere:5432/app",
      })
    ).toThrow(SAME_HOST_AND_DATABASE_RE);
  });

  it("refuses a migrator connection naming a different database", () => {
    expect(() =>
      requireFixtureDatabaseUrl("a fixture", {
        ...BASE_ENV,
        DATABASE_URL: RUNTIME_URL,
        MIGRATE_DATABASE_URL: "postgresql://migrator@localhost:5432/other",
      })
    ).toThrow(SAME_HOST_AND_DATABASE_RE);
  });

  it("accepts a migrator connection that differs only in credentials", () => {
    expect(
      requireFixtureDatabaseUrl("a fixture", {
        ...BASE_ENV,
        DATABASE_URL: RUNTIME_URL,
        MIGRATE_DATABASE_URL: MIGRATOR_URL,
      })
    ).toBe(MIGRATOR_URL);
  });

  it("has nothing to compare when no split is configured", () => {
    expect(
      requireFixtureDatabaseUrl("a fixture", {
        ...BASE_ENV,
        DATABASE_URL: RUNTIME_URL,
      })
    ).toBe(RUNTIME_URL);
  });

  it("accepts a pair that spells the default port on only one side", () => {
    // `pg` dials 5432 for both spellings, so these name one backend. Compared
    // as `URL.host` they do not match, and the whole tier would be refused
    // before it started over a difference that does not exist.
    expect(
      requireFixtureDatabaseUrl("a fixture", {
        ...BASE_ENV,
        DATABASE_URL: "postgresql://runtime@localhost/app",
        MIGRATE_DATABASE_URL: MIGRATOR_URL,
      })
    ).toBe(MIGRATOR_URL);
  });

  it("still refuses a migrator connection on a genuinely different port", () => {
    expect(() =>
      requireFixtureDatabaseUrl("a fixture", {
        ...BASE_ENV,
        DATABASE_URL: RUNTIME_URL,
        MIGRATE_DATABASE_URL: "postgresql://migrator@localhost:5433/app",
      })
    ).toThrow(SAME_HOST_AND_DATABASE_RE);
  });
});

describe("analyzeOnSeedingConnection", () => {
  it("ANALYZEs each table when the seeding role owns them all", async () => {
    const calls: QueryCall[] = [];

    await analyzeOnSeedingConnection(
      probeClient([], calls),
      SEEDED_TABLES,
      SEED_PURPOSE
    );

    expect(calls[0]?.values).toEqual([[...SEEDED_TABLES]]);
    expect(calls.slice(1).map((call) => call.query)).toEqual([
      "ANALYZE session_detail",
      "ANALYZE artifacts",
    ]);
  });

  it("refuses, naming the unowned table, instead of letting Postgres skip it", async () => {
    // TWO tables with only one unowned: a check that asked about the set as a
    // whole would pass this case. Under the ISS-5978 split Postgres reports the
    // skipped ANALYZE as a success, so nothing downstream can fail on it and
    // the guard goes on costing its plan from whatever statistics were there.
    const calls: QueryCall[] = [];

    await expect(
      analyzeOnSeedingConnection(
        probeClient([{ tableName: "artifacts" }], calls),
        SEEDED_TABLES,
        SEED_PURPOSE
      )
    ).rejects.toThrow(UNOWNED_ARTIFACTS_RE);

    expect(calls).toHaveLength(1);
  });
});

describe("asFixtureRawClient", () => {
  it("passes the statement and its bind values through as one array", async () => {
    const calls: QueryCall[] = [];
    const client = asFixtureRawClient(
      fakeClient({ rows: [{ indexname: "idx" }], rowCount: 1 }, calls)
    );

    const rows = await client.$queryRawUnsafe<{ indexname: string }[]>(
      "SELECT indexname FROM pg_indexes WHERE tablename = $1",
      "artifacts"
    );

    expect(rows).toEqual([{ indexname: "idx" }]);
    expect(calls).toEqual([
      {
        query: "SELECT indexname FROM pg_indexes WHERE tablename = $1",
        values: ["artifacts"],
      },
    ]);
  });

  it("reports a statement that affects no rows as 0, never as null", async () => {
    // `ANALYZE` and every other utility statement come back with a null
    // `rowCount`, and the Prisma surface this stands in for is typed `number`.
    const client = asFixtureRawClient(
      fakeClient({ rows: [], rowCount: null }, [])
    );

    await expect(client.$executeRawUnsafe("ANALYZE artifacts")).resolves.toBe(
      0
    );
  });
});

describe("withRolledBackFixtureTransaction", () => {
  beforeEach(() => {
    pgStub.queries.length = 0;
    pgStub.failOn = null;
    vi.stubEnv("DATABASE_URL", RUNTIME_URL);
    vi.stubEnv("MIGRATE_DATABASE_URL", MIGRATOR_URL);
  });

  // Unconditional, so a throwing case cannot leak a stubbed connection string
  // into every later file this worker runs.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rolls back on the SUCCESS path, not only on a throw", async () => {
    await withRolledBackFixtureTransaction(ROLLED_BACK_PURPOSE, (client) =>
      client.$executeRawUnsafe('DROP INDEX "idx"')
    );

    expect(pgStub.queries).toEqual(["BEGIN", 'DROP INDEX "idx"', "ROLLBACK"]);
  });

  it("rolls back when the body throws, and rethrows", async () => {
    await expect(
      withRolledBackFixtureTransaction(ROLLED_BACK_PURPOSE, () => {
        throw new Error("counterfactual proved nothing");
      })
    ).rejects.toThrow(COUNTERFACTUAL_RE);

    expect(pgStub.queries).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("keeps the body's error when the ROLLBACK also fails", async () => {
    // The body's error is the 42501 this module exists to surface; an aborted
    // transaction is also the likeliest reason the ROLLBACK is unhappy, so
    // letting it win would report the symptom and discard the diagnosis.
    pgStub.failOn = "ROLLBACK";

    await expect(
      withRolledBackFixtureTransaction(ROLLED_BACK_PURPOSE, () => {
        throw new Error("counterfactual proved nothing");
      })
    ).rejects.toThrow(COUNTERFACTUAL_RE);
  });

  it("raises a failing ROLLBACK when the body succeeded", async () => {
    // Nothing else would say the dropped index is still dropped, and the
    // integration tier shares one database with every later suite.
    pgStub.failOn = "ROLLBACK";

    await expect(
      withRolledBackFixtureTransaction(ROLLED_BACK_PURPOSE, (client) =>
        client.$executeRawUnsafe('DROP INDEX "idx"')
      )
    ).rejects.toThrow(ROLLBACK_FAILED_RE);
  });
});

/**
 * A raw client whose ownership probe answers with `unowned`, recording every
 * statement so a test can assert that the ANALYZEs were NOT issued.
 */
function probeClient(
  unowned: { tableName: string }[],
  calls: QueryCall[]
): FixtureRawClient {
  return {
    $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      calls.push({ query, values });
      return Promise.resolve(unowned as T);
    },
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
      calls.push({ query, values });
      return Promise.resolve(0);
    },
  };
}
