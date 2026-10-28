/**
 * Unit tests for `executeDrop` — the last thing that runs before a dynamic
 * schema identifier is interpolated into DDL.
 *
 * Three properties are pinned here, the first two of which the wider cleanup
 * suites can only observe indirectly because every caller happens to feed this
 * helper a `preview_*` name today:
 *
 * (1) the `preview_` prefix guard refuses, and refuses BEFORE opening a
 *     connection, so a non-preview name never reaches raw DDL at all;
 * (2) the identifier escaping doubles an embedded `"`, keeping the whole name
 *     inside one quoted identifier;
 * (3) ISS-5978: the DROP runs on the MIGRATOR connection and never on the
 *     runtime pool (`withDb` / `withDb.tx`), which is being demoted to
 *     DML-only and could not own a schema to drop it.
 *
 * Neither is a bug report: both behave correctly today. They had no test, and
 * the nearest existing assertion — the `/^DROP SCHEMA IF EXISTS/` shape regex
 * in `preview-schemas-queue-ttl.test.ts` — matches whether or not the quote was
 * doubled, so it cannot see (2) regress.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockWithDb, mockWithDbTx, mockWithMigratorClient } = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockWithMigratorClient: vi.fn(),
}));

// The runtime pool stays mocked as a trip-wire: nothing here may reach it.
vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
}));

vi.mock("@/app/preview-schemas/service/migrator-connection", () => ({
  withMigratorClient: mockWithMigratorClient,
}));

import { executeDrop } from "@/app/preview-schemas/service/drop-execution";

/** The message the prefix guard throws with. */
const SAFETY_GUARD_MESSAGE =
  "Safety guard: refusing to drop non-preview schema";

/**
 * A schema name carrying an embedded `"` plus a second statement, i.e. what an
 * unescaped interpolation would let out of the quoted identifier. Postgres
 * permits a quote inside a quoted identifier, and the sweep feeds `nspname`
 * straight from `pg_namespace`, so such a name is reachable rather than
 * hypothetical.
 */
const QUOTE_BEARING_SCHEMA = 'preview_a"; DROP SCHEMA public CASCADE; --';

/** What the escaping must produce: the embedded quote DOUBLED, nothing split. */
const EXPECTED_QUOTED_DROP =
  'DROP SCHEMA IF EXISTS "preview_a""; DROP SCHEMA public CASCADE; --" CASCADE';

describe("executeDrop safety guard", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockWithMigratorClient.mockReset();
  });

  it.each(["public", "symphony"])(
    "refuses to drop non-preview schema %s without opening a connection",
    async (schemaName) => {
      await expect(executeDrop(schemaName)).rejects.toThrow(
        SAFETY_GUARD_MESSAGE
      );

      // The guard is only a safety boundary if it short-circuits: reaching
      // the migrator connection at all means the name got as far as raw DDL.
      expect(mockWithMigratorClient).not.toHaveBeenCalled();
    }
  );

  it("names the refused schema in the thrown message", async () => {
    await expect(executeDrop("public")).rejects.toThrow(
      `${SAFETY_GUARD_MESSAGE} "public"`
    );
  });

  it("refuses a name that merely contains the preview prefix later on", async () => {
    await expect(executeDrop("not_preview_x")).rejects.toThrow(
      SAFETY_GUARD_MESSAGE
    );
    expect(mockWithMigratorClient).not.toHaveBeenCalled();
  });
});

describe("executeDrop identifier escaping", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockWithMigratorClient.mockReset();
  });

  it("doubles an embedded quote so the whole name stays inside one identifier", async () => {
    const statements = captureDropStatements();

    await executeDrop(QUOTE_BEARING_SCHEMA);

    // Exact equality, not a shape match: a shape regex anchored on
    // `DROP SCHEMA IF EXISTS` passes whether or not the quote was doubled,
    // which is precisely the regression this case exists to catch.
    expect(statements[3]).toBe(EXPECTED_QUOTED_DROP);
    expect(statements[3]).toContain('""');
  });

  it("issues the guarded DROP in one transaction on the migrator connection", async () => {
    const statements = captureDropStatements();

    await executeDrop(QUOTE_BEARING_SCHEMA);

    expect(mockWithMigratorClient).toHaveBeenCalledOnce();
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("SET LOCAL lock_timeout"),
      expect.stringContaining("SET LOCAL statement_timeout"),
      EXPECTED_QUOTED_DROP,
      "COMMIT",
    ]);
  });

  // ISS-5978 AC: the runtime pool never issues the DROP. `withDb.tx` is the
  // path the DROP took before the split; reverting to it turns this red.
  it("never reaches the runtime pool", async () => {
    captureDropStatements();

    await executeDrop("preview_feat_plain_1234");

    expect(mockWithDbTx).not.toHaveBeenCalled();
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("leaves a quote-free preview name unchanged", async () => {
    const statements = captureDropStatements();

    await executeDrop("preview_feat_plain_1234");

    expect(statements[3]).toBe(
      'DROP SCHEMA IF EXISTS "preview_feat_plain_1234" CASCADE'
    );
  });
});

/**
 * Arms `withMigratorClient` for one call and returns the array every statement
 * the DROP issues on that client is pushed into, in issue order.
 */
function captureDropStatements(): string[] {
  const statements: string[] = [];
  mockWithMigratorClient.mockImplementationOnce(
    (fn: (client: unknown) => unknown) =>
      fn({
        query: vi.fn((sql: string) => {
          statements.push(sql);
          return Promise.resolve({ rows: [] });
        }),
      })
  );
  return statements;
}
