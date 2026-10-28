import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../db-utils";
import { createSqlClient } from "../db-utils";
import {
  formatInvalidIndexReport,
  formatMigrateCompletionLine,
  resolveSweepSchema,
  sweepInvalidIndexes,
} from "../invalid-index-sweep";

vi.mock("../db-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db-utils")>();
  return { ...actual, createSqlClient: vi.fn(actual.createSqlClient) };
});

function makeClient(overrides: Partial<SqlClient> = {}): SqlClient {
  return {
    connect: vi.fn(() => Promise.resolve()),
    query: vi.fn(() => Promise.resolve({ rows: [] })),
    end: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveSweepSchema", () => {
  it("prefers a non-empty ?schema= query param on the DATABASE_URL", () => {
    expect(
      resolveSweepSchema(
        "postgresql://u:p@host:5432/db?schema=from_url",
        "from_argument"
      )
    ).toBe("from_url");
  });

  it("treats an empty ?schema= query param as absent and falls back to the argument", () => {
    expect(
      resolveSweepSchema(
        "postgresql://u:p@host:5432/db?schema=",
        "from_argument"
      )
    ).toBe("from_argument");
  });

  it("falls back to the schema argument when the URL carries no schema param", () => {
    expect(
      resolveSweepSchema("postgresql://u:p@host:5432/db", "from_argument")
    ).toBe("from_argument");
  });

  it("falls back to public when neither the URL nor the argument name a schema", () => {
    expect(resolveSweepSchema("postgresql://u:p@host:5432/db", null)).toBe(
      "public"
    );
  });

  it("falls back to the schema argument when the DATABASE_URL cannot be parsed", () => {
    // pins current behavior; looks odd because an unparseable connection
    // string would already have failed the earlier `new URL()` guards in
    // evaluateSeedGuards — this resolver treats it as "no schema in the URL"
    // rather than propagating the parse failure.
    expect(resolveSweepSchema("not a url", "from_argument")).toBe(
      "from_argument"
    );
  });
});

describe("formatMigrateCompletionLine", () => {
  it("reports UNVERIFIED when the sweep did not run", () => {
    expect(formatMigrateCompletionLine(null)).toContain(
      "index state UNVERIFIED"
    );
  });

  it("reports success when the sweep found nothing", () => {
    expect(formatMigrateCompletionLine([])).toBe(
      "✓ Migrations completed successfully"
    );
  });

  it("names every invalid index when the sweep found some", () => {
    const line = formatMigrateCompletionLine([
      {
        schema: "public",
        name: "idx_a",
        table: "t",
        ready: true,
        definition: "x",
      },
      {
        schema: "public",
        name: "idx_b",
        table: "t",
        ready: false,
        definition: "y",
      },
    ]);
    expect(line).toContain("2 INVALID index(es) remain");
    expect(line).toContain("public.idx_a, public.idx_b");
  });
});

describe("formatInvalidIndexReport", () => {
  it("describes an index with no ready/table/definition info, and both ready states", () => {
    const report = formatInvalidIndexReport([
      {
        schema: "public",
        name: "idx_unknown",
        table: null,
        ready: null,
        definition: null,
      },
      {
        schema: "public",
        name: "idx_built",
        table: "sessions",
        ready: true,
        definition: 'CREATE INDEX "idx_built" ON "sessions" ("id")',
      },
      {
        schema: "public",
        name: "idx_unbuilt",
        table: "branches",
        ready: false,
        definition: 'CREATE UNIQUE INDEX "idx_unbuilt" ON "branches" ("id")',
      },
    ]);

    expect(report).toContain("3 INVALID index(es) found");
    expect(report).toContain("(table unknown — index dropped mid-sweep)");
    expect(report).toContain(
      "-- definition unavailable (index dropped mid-sweep); re-run the detection query"
    );
    expect(report).toContain("(built, but its validation pass never finished)");
    expect(report).toContain("(its first build pass never finished)");
    expect(report).toContain(
      'CREATE INDEX CONCURRENTLY "idx_built" ON "sessions" ("id")'
    );
    expect(report).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY "idx_unbuilt" ON "branches" ("id")'
    );
  });
});

describe("sweepInvalidIndexes", () => {
  it("drops rows missing required identity fields and keeps rows with partial descriptive fields", async () => {
    const client = makeClient({
      query: vi.fn((text: string) => {
        if (typeof text === "string" && text.startsWith("SET")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({
          rows: [
            {
              schema: "public",
              name: "idx_full",
              table: "t",
              ready: true,
              definition: "d",
            },
            { schema: "public", name: "idx_partial" },
            { name: "missing_schema" },
          ],
        });
      }),
    });
    const logger = { warn: vi.fn() };

    const result = await sweepInvalidIndexes("postgresql://u:p@host/db", null, {
      createClient: () => client,
      logger,
    });

    expect(result).toEqual([
      {
        schema: "public",
        name: "idx_full",
        table: "t",
        ready: true,
        definition: "d",
      },
      {
        schema: "public",
        name: "idx_partial",
        table: null,
        ready: null,
        definition: null,
      },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not log a report when no invalid indexes are found", async () => {
    const client = makeClient();
    const logger = { warn: vi.fn() };

    const result = await sweepInvalidIndexes("postgresql://u:p@host/db", null, {
      createClient: () => client,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("clamps the statement timeout against a supplied budget rather than the fixed default", async () => {
    // Freeze Date.now so the connect spends none of the budget.
    vi.useFakeTimers({ toFake: ["Date"] });
    const queries: unknown[] = [];
    const client = makeClient({
      query: vi.fn((text: string) => {
        queries.push(text);
        return Promise.resolve({ rows: [] });
      }),
    });

    await sweepInvalidIndexes("postgresql://u:p@host/db", null, {
      createClient: () => client,
      budgetMs: 5000,
    });

    const setStatement = queries.find(
      (text) => typeof text === "string" && text.startsWith("SET")
    );
    // 5000ms is above the clamp's floor and below the fixed 30_000ms default.
    expect(setStatement).toBe("SET statement_timeout = '5000ms'");
  });

  it("returns null and warns with the Error message when the client throws an Error", async () => {
    const client = makeClient({
      connect: vi.fn(() => Promise.reject(new Error("connection refused"))),
    });
    const logger = { warn: vi.fn() };

    const result = await sweepInvalidIndexes("postgresql://u:p@host/db", null, {
      createClient: () => client,
      logger,
    });

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("connection refused")
    );
  });

  it("returns null and stringifies a non-Error throw", async () => {
    const client = makeClient({
      connect: vi.fn(() => Promise.reject("not an Error instance")),
    });
    const logger = { warn: vi.fn() };

    const result = await sweepInvalidIndexes("postgresql://u:p@host/db", null, {
      createClient: () => client,
      logger,
    });

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not an Error instance")
    );
  });

  it("falls back to the shared createSqlClient factory when no deps.createClient is supplied", async () => {
    const client = makeClient({
      connect: vi.fn(() => Promise.reject(new Error("refused"))),
    });
    vi.mocked(createSqlClient).mockReturnValueOnce(client);

    const result = await sweepInvalidIndexes(
      "postgresql://u:p@host:5432/db",
      null,
      { budgetMs: 1 }
    );

    expect(result).toBeNull();
    expect(createSqlClient).toHaveBeenCalledWith(
      "postgresql://u:p@host:5432/db",
      expect.any(Object)
    );
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("still closes the client when the sweep query itself throws", async () => {
    const client = makeClient({
      query: vi.fn((text: string) => {
        if (typeof text === "string" && text.startsWith("SET")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.reject(new Error("boom"));
      }),
    });

    const result = await sweepInvalidIndexes("postgresql://u:p@host/db", null, {
      createClient: () => client,
    });

    expect(result).toBeNull();
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
