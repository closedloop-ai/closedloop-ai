import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  CLONE_BEGIN_SQL,
  CloneFailedError,
  cloneDataFromPublic,
} from "../clone-schema";

const PREVIEW_SCHEMA = "preview_feature_branch_abc123";
const DATABASE_URL =
  "postgresql://user:pass@db.example.com:5432/closedloop?sslmode=require";
const ZERO_ROWS_LOG = /document: 0 rows \(\d+ms\)/;
const TABLES_CATALOG_QUERY = /c\.relkind = 'r'/;

const mockCreateSslClient = vi.hoisted(() => vi.fn());

vi.mock("../db-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db-utils")>();
  return { ...actual, createSslClient: mockCreateSslClient };
});

type ColumnRow = {
  column_name: string;
  is_enum: boolean;
  is_enum_array: boolean;
  enum_type: string;
  generated: string;
  identity: string;
};

function col(
  overrides: Partial<ColumnRow> & { column_name: string }
): ColumnRow {
  return {
    is_enum: false,
    is_enum_array: false,
    enum_type: "text",
    generated: "",
    identity: "",
    ...overrides,
  };
}

function makeClient(opts: {
  tables?: string[];
  tableColumns?: Record<string, ColumnRow[]>;
  fkEdges?: { child: string; parent: string }[];
  targetFkConstraints?: { table_name: string; constraint_name: string }[];
  insertRowCount?: number | null | undefined;
  throwOnQuery?: { match: RegExp; value: unknown };
}) {
  const tables = opts.tables ?? [];
  const issued: string[] = [];
  const client = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((sql: string, params?: unknown[]) => {
      issued.push(sql);
      if (opts.throwOnQuery?.match.test(sql)) {
        return Promise.reject(opts.throwOnQuery.value);
      }
      if (sql === CLONE_BEGIN_SQL || sql === "COMMIT" || sql === "ROLLBACK") {
        return Promise.resolve({ rowCount: null, rows: [] });
      }
      if (sql.startsWith("SET CONSTRAINTS")) {
        return Promise.resolve({ rowCount: null, rows: [] });
      }
      if (sql.includes("pg_catalog.pg_attribute a")) {
        const schema = String(params?.[0]);
        const table = String(params?.[1]);
        const all = opts.tableColumns?.[table] ?? [];
        if (schema === "public") {
          return Promise.resolve({ rows: all });
        }
        return Promise.resolve({ rows: all });
      }
      if (
        sql.includes("c.relkind = 'r'") &&
        !sql.includes("pg_catalog.pg_trigger")
      ) {
        return Promise.resolve({
          rows: tables.map((table_name) => ({ table_name })),
        });
      }
      if (sql.includes("con.conname AS constraint_name")) {
        return Promise.resolve({ rows: opts.targetFkConstraints ?? [] });
      }
      if (sql.includes("con.contype = 'f'")) {
        return Promise.resolve({ rows: opts.fkEdges ?? [] });
      }
      if (sql.startsWith("INSERT INTO")) {
        return Promise.resolve({ rowCount: opts.insertRowCount });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    }),
  };
  return { client: client as unknown as pg.Client, issued, spies: client };
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("cloneDataFromPublic — default deps (deps = {})", () => {
  it("falls back to createSslClient, console, and process.env when no deps are supplied", async () => {
    const { client } = makeClient({ tables: [] });
    mockCreateSslClient.mockReturnValueOnce(client);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // silence
    });
    const originalConnectTimeout = process.env.CLONE_CONNECT_TIMEOUT_MS;
    process.env.CLONE_CONNECT_TIMEOUT_MS = "4321";

    try {
      await cloneDataFromPublic(DATABASE_URL, PREVIEW_SCHEMA);
    } finally {
      if (originalConnectTimeout === undefined) {
        Reflect.deleteProperty(process.env, "CLONE_CONNECT_TIMEOUT_MS");
      } else {
        process.env.CLONE_CONNECT_TIMEOUT_MS = originalConnectTimeout;
      }
    }

    // The override is read from process.env.
    expect(mockCreateSslClient).toHaveBeenCalledWith(DATABASE_URL, {
      connectionTimeoutMillis: 4321,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cloning data from public schema")
    );
    consoleLogSpy.mockRestore();
  });
});

describe("cloneDataFromPublic — FK graph edge cases (getTablesInFkOrder)", () => {
  it("ignores a self-referencing FK edge without treating it as a dependency", async () => {
    const { client, issued } = makeClient({
      tables: ["node"],
      fkEdges: [{ child: "node", parent: "node" }],
      tableColumns: { node: [col({ column_name: "id" })] },
    });
    const logger = makeLogger();

    await cloneDataFromPublic(DATABASE_URL, PREVIEW_SCHEMA, {
      createClient: () => client,
      logger,
      env: {},
    });

    // A self-loop would otherwise block topo-sort readiness forever; the table
    // still gets cloned and no FK-cycle warning fires for it.
    expect(issued.some((sql) => sql.startsWith("INSERT INTO"))).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("FK cycle")
    );
  });

  it("drops and warns about an FK edge whose endpoint is outside the clone set", async () => {
    const { client } = makeClient({
      tables: ["document"],
      // `preview_schemas` is excluded from the clone set (CLONE_SKIP_TABLES),
      // so this edge's parent is never in `deps` and must be dropped loudly.
      fkEdges: [{ child: "document", parent: "preview_schemas" }],
      tableColumns: { document: [col({ column_name: "id" })] },
    });
    const logger = makeLogger();

    await cloneDataFromPublic(DATABASE_URL, PREVIEW_SCHEMA, {
      createClient: () => client,
      logger,
      env: {},
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("document->preview_schemas")
    );
  });
});

describe("cloneDataFromPublic — per-table column edge cases", () => {
  it("skips a table entirely missing from the target schema's columns", async () => {
    const { client, issued } = makeClient({
      tables: ["ghost_table"],
      tableColumns: { ghost_table: [] },
    });
    const logger = makeLogger();

    await cloneDataFromPublic(DATABASE_URL, PREVIEW_SCHEMA, {
      createClient: () => client,
      logger,
      env: {},
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("missing in target schema")
    );
    expect(issued.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);
  });

  it("logs 0 rows when the driver reports a null rowCount for the INSERT", async () => {
    const { client } = makeClient({
      tables: ["document"],
      tableColumns: { document: [col({ column_name: "id" })] },
      insertRowCount: null,
    });
    const logger = makeLogger();

    await cloneDataFromPublic(DATABASE_URL, PREVIEW_SCHEMA, {
      createClient: () => client,
      logger,
      env: {},
    });

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringMatching(ZERO_ROWS_LOG)
    );
  });
});

describe("cloneDataFromPublic — failure classification and cleanup", () => {
  it("stringifies a non-Error throw rather than reading .message off it", async () => {
    const { client, spies } = makeClient({
      tables: ["document"],
      throwOnQuery: { match: TABLES_CATALOG_QUERY, value: "connection reset" },
    });
    const logger = makeLogger();

    await expect(
      cloneDataFromPublic(DATABASE_URL, PREVIEW_SCHEMA, {
        createClient: () => client,
        logger,
        env: {},
      })
    ).rejects.toThrow(CloneFailedError);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("connection reset")
    );
    expect(spies.end).toHaveBeenCalledTimes(1);
  });

  it("logs the error and throws a CloneFailedError when createClient itself throws synchronously", async () => {
    const logger = makeLogger();
    const boom = new Error("credentials rejected");

    await expect(
      cloneDataFromPublic(DATABASE_URL, PREVIEW_SCHEMA, {
        createClient: () => {
          throw boom;
        },
        logger,
        env: {},
      })
    ).rejects.toThrow(CloneFailedError);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("credentials rejected")
    );
  });
});
