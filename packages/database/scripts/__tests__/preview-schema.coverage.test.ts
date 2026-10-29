import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureSchemaExists,
  isPreviewSchema,
  resetSchema,
  upsertSchemaRegistry,
} from "../preview-schema";
import {
  formatVibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
} from "../vibe-environment";

const DATABASE_URL =
  "postgresql://user:pass@db.example.com:5432/closedloop?sslmode=require";

const mockCreateSslClient = vi.hoisted(() => vi.fn());

vi.mock("../db-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db-utils")>();
  return { ...actual, createSslClient: mockCreateSslClient };
});

beforeEach(() => {
  mockCreateSslClient.mockClear();
});

function makeClient() {
  const issued: { sql: string; params?: unknown[] }[] = [];
  const client = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((sql: string, params?: unknown[]) => {
      issued.push({ sql, params });
      if (sql.includes("information_schema.schemata")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
  return { client: client as unknown as pg.Client, issued, spies: client };
}

describe("isPreviewSchema", () => {
  it("returns false for null and for a schema without the preview_ prefix", () => {
    expect(isPreviewSchema(null)).toBe(false);
    expect(isPreviewSchema("public")).toBe(false);
  });

  it("returns true for a schema carrying the preview_ prefix", () => {
    expect(isPreviewSchema("preview_feature_branch")).toBe(true);
  });
});

describe("ensureSchemaExists", () => {
  it("returns false without opening a connection when schema is null", async () => {
    const result = await ensureSchemaExists(DATABASE_URL, null);
    expect(result).toBe(false);
    expect(mockCreateSslClient).not.toHaveBeenCalled();
  });

  it("connects and creates the schema when given a schema name", async () => {
    const { client, issued, spies } = makeClient();
    mockCreateSslClient.mockReturnValueOnce(client);

    const result = await ensureSchemaExists(DATABASE_URL, "preview_abc123");

    expect(result).toBe(true);
    expect(issued).toEqual([
      {
        sql: "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
        params: ["preview_abc123"],
      },
      {
        sql: 'CREATE SCHEMA IF NOT EXISTS "preview_abc123"',
        params: undefined,
      },
    ]);
    expect(spies.end).toHaveBeenCalledTimes(1);
  });
});

describe("resetSchema", () => {
  it("refuses a null schema", async () => {
    await expect(resetSchema(DATABASE_URL, null)).rejects.toThrow(
      "resetSchema refused: null is not a preview schema"
    );
    expect(mockCreateSslClient).not.toHaveBeenCalled();
  });

  it("refuses a non-preview schema", async () => {
    await expect(resetSchema(DATABASE_URL, "public")).rejects.toThrow(
      "resetSchema refused: public is not a preview schema"
    );
    expect(mockCreateSslClient).not.toHaveBeenCalled();
  });

  it("drops and recreates a genuine preview_ schema", async () => {
    const { client, issued, spies } = makeClient();
    mockCreateSslClient.mockReturnValueOnce(client);

    await resetSchema(DATABASE_URL, "preview_abc123");

    expect(issued.some((q) => q.sql.includes("DROP SCHEMA IF EXISTS"))).toBe(
      true
    );
    expect(issued.some((q) => q.sql.startsWith("CREATE SCHEMA"))).toBe(true);
    expect(spies.end).toHaveBeenCalledTimes(1);
  });

  it("carries the schema comment (the vibe environment marker) across the recreate", async () => {
    const marker = `{"closedloopVibeEnvironment":{"mode":"blank","state":"ready"}}`;
    const issued: string[] = [];
    const client = {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn((sql: string) => {
        issued.push(sql);
        return Promise.resolve({
          rows: sql.includes("obj_description") ? [{ comment: marker }] : [],
        });
      }),
    };
    mockCreateSslClient.mockReturnValueOnce(client);

    await resetSchema(DATABASE_URL, "preview_abc123");

    const create = issued.findIndex((sql) => sql.startsWith("CREATE SCHEMA"));
    const comment = issued.findIndex((sql) =>
      sql.startsWith("COMMENT ON SCHEMA")
    );
    expect(create).toBeGreaterThan(-1);
    expect(comment).toBeGreaterThan(create);
    expect(issued[comment]).toBe(
      `COMMENT ON SCHEMA "preview_abc123" IS '${marker}'`
    );
  });

  it("marks a seeded environment pending after its rows are reset", async () => {
    const seededReady = formatVibeEnvironmentMarker({
      mode: VibeEnvironmentMode.Seeded,
      state: VibeEnvironmentState.Ready,
    });
    const seededPending = formatVibeEnvironmentMarker({
      mode: VibeEnvironmentMode.Seeded,
      state: VibeEnvironmentState.Pending,
    });
    const issued: string[] = [];
    const client = {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn((sql: string) => {
        issued.push(sql);
        return Promise.resolve({
          rows: sql.includes("obj_description")
            ? [{ comment: seededReady }]
            : [],
        });
      }),
    };
    mockCreateSslClient.mockReturnValueOnce(client);

    await resetSchema(DATABASE_URL, "preview_abc123");

    expect(issued.at(-1)).toBe(
      `COMMENT ON SCHEMA "preview_abc123" IS '${seededPending}'`
    );
  });

  it("writes no comment when the schema had none", async () => {
    const { client, issued } = makeClient();
    mockCreateSslClient.mockReturnValueOnce(client);

    await resetSchema(DATABASE_URL, "preview_abc123");

    expect(issued.some((q) => q.sql.startsWith("COMMENT ON SCHEMA"))).toBe(
      false
    );
  });
});

describe("upsertSchemaRegistry", () => {
  it("no-ops for a non-preview schema without opening a connection", async () => {
    await upsertSchemaRegistry(DATABASE_URL, "public", "main");
    expect(mockCreateSslClient).not.toHaveBeenCalled();
  });

  it("no-ops for a null schema without opening a connection", async () => {
    await upsertSchemaRegistry(DATABASE_URL, null, "main");
    expect(mockCreateSslClient).not.toHaveBeenCalled();
  });

  it("coalesces an undefined branch to null in the upsert params", async () => {
    const { client, issued } = makeClient();
    mockCreateSslClient.mockReturnValueOnce(client);

    await upsertSchemaRegistry(DATABASE_URL, "preview_abc123", undefined);

    const upsert = issued.find((q) =>
      q.sql.includes("INSERT INTO preview_schemas")
    );
    expect(upsert?.params).toEqual(["preview_abc123", null]);
  });

  it("passes the branch through unchanged when provided", async () => {
    const { client, issued } = makeClient();
    mockCreateSslClient.mockReturnValueOnce(client);

    await upsertSchemaRegistry(DATABASE_URL, "preview_abc123", "feature/x");

    const upsert = issued.find((q) =>
      q.sql.includes("INSERT INTO preview_schemas")
    );
    expect(upsert?.params).toEqual(["preview_abc123", "feature/x"]);
  });
});
