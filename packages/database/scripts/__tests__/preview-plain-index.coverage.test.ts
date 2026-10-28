import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../preview-heavy-migrations", () => ({
  PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS: ["mig_a", "mig_b"],
}));

const createSqlClientMock = vi.fn();
vi.mock("../db-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db-utils")>();
  return {
    ...actual,
    createSqlClient: (...args: unknown[]) => createSqlClientMock(...args),
  };
});

const { parsePlainIndexBuilds, plainBuildPreviewConcurrentIndexes } =
  await import("../preview-plain-index");

const SCHEMA = "preview_feat_abc";
const URL = "postgresql://user:pw@db.example.com:5432/cl";
const IDX_A_MISSING_REGEX = /idx_a_unique \(missing\)/;
const IDX_A_NOT_UNIQUE_REGEX = /idx_a_unique \(not unique\)/;
const IDX_A_NOT_READY_REGEX = /idx_a_unique \(not ready\)/;
const IDX_A_DEFINITION_MISMATCH_REGEX = /idx_a_unique \(definition mismatch\)/;
const BOOM_CREATE_UNIQUE_INDEX_REGEX = /boom: CREATE UNIQUE INDEX/;
const COULD_NOT_READ_MIGRATION_SQL_REGEX = /Could not read migration SQL/;
const IDX_A_INVALID_REGEX = /idx_a_unique \(invalid\)/;
const CONCURRENTLY_CASE_INSENSITIVE_REGEX = /concurrently/i;
const ONLY_CREATE_INDEX_CONCURRENTLY_REGEX =
  /may contain only CREATE \[UNIQUE\] INDEX CONCURRENTLY/;
const CANNOT_PARSE_INDEX_NAME_REGEX = /cannot parse index name/;
const SILENT = { log: () => undefined, warn: () => undefined };

const MIG_A_SQL =
  'CREATE UNIQUE INDEX CONCURRENTLY "idx_a_unique" ON "t" ("col1", "col2");';
const MIG_B_SQL = 'CREATE INDEX CONCURRENTLY "idx_b_perf" ON "t" ("col3");';

function validityRow(
  name: string,
  overrides: Partial<{
    valid: boolean;
    ready: boolean;
    unique: boolean;
    def: string;
  }> = {}
) {
  return {
    name,
    valid: true,
    ready: true,
    unique: false,
    def: "",
    ...overrides,
  };
}

/**
 * A fake SqlClient that classifies queries by shape and lets each test control
 * the pg_index validity snapshot returned on every `SELECT ... pg_index` call.
 */
function makeClient(
  opts: {
    /** Rows returned by pg_index queries, in call order (last one repeats). */
    validityRowsSequence?: ReturnType<typeof validityRow>[][];
    failOn?: string;
  } = {}
) {
  const statements: { text: string; values?: unknown[] }[] = [];
  let validityCallCount = 0;
  const client = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((text: string, values?: unknown[]) => {
      statements.push({ text, values });
      if (opts.failOn && text.includes(opts.failOn)) {
        return Promise.reject(new Error(`boom: ${opts.failOn}`));
      }
      if (text.includes("FROM pg_index")) {
        const sequence = opts.validityRowsSequence ?? [[]];
        const rows = sequence[Math.min(validityCallCount, sequence.length - 1)];
        validityCallCount += 1;
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rowCount: 1 });
    }),
  };
  return { client, statements };
}

/** A single validity snapshot returned identically pre- and post-build. */
function fixedValidity(rows: ReturnType<typeof validityRow>[]) {
  return { validityRowsSequence: [rows] };
}

afterEach(() => {
  createSqlClientMock.mockReset();
});

function readMigrationSql(name: string): string {
  if (name === "mig_a") {
    return MIG_A_SQL;
  }
  if (name === "mig_b") {
    return MIG_B_SQL;
  }
  throw new Error(`no such migration ${name}`);
}

describe("parsePlainIndexBuilds", () => {
  it("parses a UNIQUE CONCURRENTLY statement that already has IF NOT EXISTS", () => {
    const builds = parsePlainIndexBuilds(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_u" ON "t" ("a", "b");'
    );

    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      name: "idx_u",
      unique: true,
      columns: ["a", "b"],
    });
    expect(builds[0]?.sql).not.toMatch(CONCURRENTLY_CASE_INSENSITIVE_REGEX);
    expect(builds[0]?.sql).toContain("IF NOT EXISTS");
    // Already had IF NOT EXISTS, so it must not be duplicated.
    expect(builds[0]?.sql.match(/IF NOT EXISTS/gi)?.length).toBe(1);
  });

  it("parses a non-unique CONCURRENTLY statement without IF NOT EXISTS and inserts it", () => {
    const builds = parsePlainIndexBuilds(
      'CREATE INDEX CONCURRENTLY "idx_p" ON "t" ("c");'
    );

    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      name: "idx_p",
      unique: false,
      columns: ["c"],
    });
    expect(builds[0]?.sql).toContain("IF NOT EXISTS");
  });

  it("skips empty fragments between statements", () => {
    const builds = parsePlainIndexBuilds(`${MIG_A_SQL}\n\n;\n${MIG_B_SQL}`);
    expect(builds.map((b) => b.name)).toEqual(["idx_a_unique", "idx_b_perf"]);
  });

  it("strips line and block comments before parsing", () => {
    const sql = `-- a leading comment\n/* block\ncomment */ ${MIG_B_SQL} -- trailing`;
    const builds = parsePlainIndexBuilds(sql);
    expect(builds).toHaveLength(1);
    expect(builds[0]?.name).toBe("idx_b_perf");
  });

  it("throws on any non-index-CONCURRENTLY statement", () => {
    expect(() =>
      parsePlainIndexBuilds('ALTER TABLE "t" ADD COLUMN "x" TEXT;')
    ).toThrow(ONLY_CREATE_INDEX_CONCURRENTLY_REGEX);
  });

  it("throws when the index name cannot be parsed", () => {
    expect(() =>
      parsePlainIndexBuilds("CREATE INDEX CONCURRENTLY idx_unquoted ON t (c);")
    ).toThrow(CANNOT_PARSE_INDEX_NAME_REGEX);
  });
});

describe("plainBuildPreviewConcurrentIndexes — guard branches", () => {
  it("is a no-op for a null schema", async () => {
    const { client } = makeClient();
    await plainBuildPreviewConcurrentIndexes(URL, null, {
      createClient: () => client,
      readMigrationSql,
      logger: SILENT,
    });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("is a no-op for a non-preview schema (e.g. public)", async () => {
    const { client } = makeClient();
    await plainBuildPreviewConcurrentIndexes(URL, "public", {
      createClient: () => client,
      readMigrationSql,
      logger: SILENT,
    });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("is a no-op when the declared migrations yield zero index builds", async () => {
    const { client } = makeClient();
    await plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
      createClient: () => client,
      readMigrationSql: () => "",
      logger: SILENT,
    });
    expect(client.connect).not.toHaveBeenCalled();
  });
});

describe("plainBuildPreviewConcurrentIndexes — happy path", () => {
  it("builds both indexes, verifies them usable, and logs success", async () => {
    const { client, statements } = makeClient(
      fixedValidity([
        validityRow("idx_a_unique", {
          unique: true,
          def: "USING btree (col1, col2)",
        }),
        validityRow("idx_b_perf", { def: "USING btree (col3)" }),
      ])
    );
    const logger = { log: vi.fn(), warn: vi.fn() };

    await plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
      createClient: () => client,
      readMigrationSql,
      logger,
    });

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(
      statements.some((s) => s.text.includes(`SET search_path TO "${SCHEMA}"`))
    ).toBe(true);
    expect(
      statements.some((s) => s.text.startsWith("CREATE UNIQUE INDEX"))
    ).toBe(true);
    expect(statements.some((s) => s.text.startsWith("CREATE INDEX"))).toBe(
      true
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("Plain-built 2 preview index(es)")
    );
  });
});

describe("plainBuildPreviewConcurrentIndexes — dropUnusablePreviewIndexes", () => {
  it("drops an existing index that is invalid", async () => {
    const { client, statements } = makeClient({
      validityRowsSequence: [
        [
          // Definition matches, so invalidity is the only failing term.
          validityRow("idx_a_unique", {
            valid: false,
            unique: true,
            def: "USING btree (col1, col2)",
          }),
          validityRow("idx_b_perf", { def: "USING btree (col3)" }),
        ],
        [
          validityRow("idx_a_unique", {
            unique: true,
            def: "USING btree (col1, col2)",
          }),
          validityRow("idx_b_perf", { def: "USING btree (col3)" }),
        ],
      ],
    });

    await plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
      createClient: () => client,
      readMigrationSql,
      logger: SILENT,
    });

    expect(
      statements.some(
        (s) =>
          s.text.includes("DROP INDEX IF EXISTS") &&
          s.text.includes("idx_a_unique")
      )
    ).toBe(true);
  });

  it("drops an existing index whose definition (columns) no longer matches", async () => {
    const { client, statements } = makeClient({
      validityRowsSequence: [
        [
          validityRow("idx_a_unique", {
            unique: true,
            def: "USING btree (col_stale)",
          }),
          validityRow("idx_b_perf", { def: "USING btree (col3)" }),
        ],
        [
          validityRow("idx_a_unique", {
            unique: true,
            def: "USING btree (col1, col2)",
          }),
          validityRow("idx_b_perf", { def: "USING btree (col3)" }),
        ],
      ],
    });

    await plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
      createClient: () => client,
      readMigrationSql,
      logger: SILENT,
    });

    expect(
      statements.some(
        (s) =>
          s.text.includes("DROP INDEX IF EXISTS") &&
          s.text.includes("idx_a_unique")
      )
    ).toBe(true);
  });

  it("does not drop an existing index that is already valid, ready, and matching", async () => {
    const { client, statements } = makeClient(
      fixedValidity([
        validityRow("idx_a_unique", {
          unique: true,
          def: "USING btree (col1, col2)",
        }),
        validityRow("idx_b_perf", { def: "USING btree (col3)" }),
      ])
    );

    await plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
      createClient: () => client,
      readMigrationSql,
      logger: SILENT,
    });

    expect(statements.some((s) => s.text.includes("DROP INDEX"))).toBe(false);
  });
});

describe("plainBuildPreviewConcurrentIndexes — fail-closed verification", () => {
  it("throws when a built index is missing from the post-build validity check", async () => {
    const { client } = makeClient(
      fixedValidity([
        // idx_a_unique never shows up post-build.
        validityRow("idx_b_perf", { def: "USING btree (col3)" }),
      ])
    );

    await expect(
      plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
        createClient: () => client,
        readMigrationSql,
        logger: SILENT,
      })
    ).rejects.toThrow(IDX_A_MISSING_REGEX);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("throws when a UNIQUE build lands as non-unique", async () => {
    const { client } = makeClient(
      fixedValidity([
        validityRow("idx_a_unique", {
          unique: false,
          def: "USING btree (col1, col2)",
        }),
        validityRow("idx_b_perf", { def: "USING btree (col3)" }),
      ])
    );

    await expect(
      plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
        createClient: () => client,
        readMigrationSql,
        logger: SILENT,
      })
    ).rejects.toThrow(IDX_A_NOT_UNIQUE_REGEX);
  });

  it("throws when a built index is not ready", async () => {
    const { client } = makeClient(
      fixedValidity([
        validityRow("idx_a_unique", { ready: false, unique: true }),
        validityRow("idx_b_perf"),
      ])
    );

    await expect(
      plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
        createClient: () => client,
        readMigrationSql,
        logger: SILENT,
      })
    ).rejects.toThrow(IDX_A_NOT_READY_REGEX);
  });

  it("throws when a built index's definition does not match the expected columns", async () => {
    const { client } = makeClient(
      fixedValidity([
        validityRow("idx_a_unique", {
          unique: true,
          def: "USING btree (col1)",
        }),
        validityRow("idx_b_perf", { def: "USING btree (col3)" }),
      ])
    );

    await expect(
      plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
        createClient: () => client,
        readMigrationSql,
        logger: SILENT,
      })
    ).rejects.toThrow(IDX_A_DEFINITION_MISMATCH_REGEX);
  });
});

describe("plainBuildPreviewConcurrentIndexes — client lifecycle on failure", () => {
  it("propagates a synchronous createClient throw without calling end", async () => {
    await expect(
      plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
        createClient: () => {
          throw new Error("bad connection string");
        },
        readMigrationSql,
        logger: SILENT,
      })
    ).rejects.toThrow("bad connection string");
  });

  it("still ends the client when a query fails mid-build", async () => {
    const { client } = makeClient({ failOn: "CREATE UNIQUE INDEX" });

    await expect(
      plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
        createClient: () => client,
        readMigrationSql,
        logger: SILENT,
      })
    ).rejects.toThrow(BOOM_CREATE_UNIQUE_INDEX_REGEX);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});

describe("plainBuildPreviewConcurrentIndexes — default deps", () => {
  it("uses the default logger (console) when none is injected", async () => {
    const { client } = makeClient(
      fixedValidity([
        validityRow("idx_a_unique", {
          unique: true,
          def: "USING btree (col1, col2)",
        }),
        validityRow("idx_b_perf", { def: "USING btree (col3)" }),
      ])
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
      createClient: () => client,
      readMigrationSql,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Plain-built 2 preview index(es)")
    );
  });

  it("uses the default createClient and readMigrationSql when omitted", async () => {
    const { client } = makeClient(
      fixedValidity([
        validityRow("idx_a_unique", {
          unique: true,
          def: "USING btree (col1, col2)",
        }),
        validityRow("idx_b_perf", { def: "USING btree (col3)" }),
      ])
    );
    createSqlClientMock.mockReturnValue(client);

    await plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
      readMigrationSql,
      logger: SILENT,
    });

    // The mocked db-utils createSqlClient stands in for the real default,
    // proving `deps.createClient ?? createSqlClient` took the default branch.
    expect(createSqlClientMock).toHaveBeenCalledWith(URL);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("propagates a throw from the default readMigrationSql when omitted", async () => {
    // pins current behavior; looks odd because "mig_a" is a fake migration
    // name from this file's mocked migrations list, so the real on-disk
    // reader throws before any client is ever created.
    await expect(
      plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
        createClient: () => {
          throw new Error("should not be reached");
        },
        logger: SILENT,
      })
    ).rejects.toThrow(COULD_NOT_READ_MIGRATION_SQL_REGEX);
  });
});

describe("plainBuildPreviewConcurrentIndexes — malformed pg_index result", () => {
  it("tolerates a result with no rows array and skips a non-string index name", async () => {
    let queryCount = 0;
    const statements: string[] = [];
    const client = {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn((text: string) => {
        statements.push(text);
        if (text.includes("FROM pg_index")) {
          queryCount += 1;
          // First call (pre-build drop check): malformed result, no `rows`.
          if (queryCount === 1) {
            return Promise.resolve({});
          }
          // Second call (post-build verify): a non-string name is present
          // alongside the two real, valid rows.
          return Promise.resolve({
            rows: [
              { name: 42, valid: true, ready: true, unique: false, def: "" },
              validityRow("idx_a_unique", {
                unique: true,
                def: "USING btree (col1, col2)",
              }),
              validityRow("idx_b_perf", { def: "USING btree (col3)" }),
            ],
          });
        }
        return Promise.resolve({ rowCount: 1 });
      }),
    };

    await plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
      createClient: () => client,
      readMigrationSql,
      logger: SILENT,
    });

    // No DROP INDEX: the malformed pre-check result fell back to an empty
    // map, so every build looked like it had no existing index to compare.
    expect(statements.some((s) => s.includes("DROP INDEX"))).toBe(false);
  });

  it("reports an index invalid at the post-build verification step", async () => {
    let queryCount = 0;
    const client = {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn((text: string) => {
        if (text.includes("FROM pg_index")) {
          queryCount += 1;
          if (queryCount === 1) {
            // Pre-build: nothing exists yet, so no drop is attempted.
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({
            rows: [
              validityRow("idx_a_unique", { valid: false, unique: true }),
              validityRow("idx_b_perf", { def: "USING btree (col3)" }),
            ],
          });
        }
        return Promise.resolve({ rowCount: 1 });
      }),
    };

    await expect(
      plainBuildPreviewConcurrentIndexes(URL, SCHEMA, {
        createClient: () => client,
        readMigrationSql,
        logger: SILENT,
      })
    ).rejects.toThrow(IDX_A_INVALID_REGEX);
  });
});
