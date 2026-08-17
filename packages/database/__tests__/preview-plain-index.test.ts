import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../scripts/db-utils";
import {
  parsePlainIndexBuilds,
  plainBuildPreviewConcurrentIndexes,
} from "../scripts/preview-plain-index";

const PREVIEW_SCHEMA = "preview_my_branch_abc12345";
const FEA3857_MIGRATION_NAME =
  "20260723030001_fea3857_search_document_concurrent_indexes";

// The FEA-3857 shape: a GIN, a composite btree, and a UNIQUE btree, all built
// CONCURRENTLY with IF NOT EXISTS.
const FEA3857_SQL = `-- comment mentioning CREATE INDEX CONCURRENTLY should be ignored
CREATE INDEX CONCURRENTLY IF NOT EXISTS "search_document_tsv_gin_idx" ON "search_document" USING GIN ("tsv");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "search_document_organization_id_entity_type_updated_at_idx" ON "search_document"("organization_id", "entity_type", "updated_at");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "search_document_organization_id_entity_type_entity_id_key" ON "search_document"("organization_id", "entity_type", "entity_id");`;

const GIN_IDX = "search_document_tsv_gin_idx";
const COMPOSITE_IDX =
  "search_document_organization_id_entity_type_updated_at_idx";
const UNIQUE_IDX = "search_document_organization_id_entity_type_entity_id_key";
const FEA3857_INDEX_NAMES = [GIN_IDX, COMPOSITE_IDX, UNIQUE_IDX];

const CONCURRENTLY_RE = /concurrently/i;
const IF_NOT_EXISTS_RE = /if\s+not\s+exists/i;
const CREATE_UNIQUE_INDEX_RE = /create\s+unique\s+index/i;
const CANNOT_PARSE_NAME_RE = /cannot parse index name/i;
const NON_INDEX_STATEMENT_RE =
  /only CREATE \[UNIQUE\] INDEX CONCURRENTLY statements/i;
const CREATE_INDEX_RE = /create .*index/i;
const ADVISORY_LOCK_RE = /pg_advisory_lock/i;
const VALIDITY_RE = /^SELECT c\.relname/;
const DROP_INDEX_RE = /drop index/i;
const NOT_USABLE_RE = /not usable/i;
const MISSING_RE = /\(missing\)/;
const NOT_UNIQUE_RE = /\(not unique\)/;
const INVALID_RE = /\(invalid\)/;
const DEFINITION_MISMATCH_RE = /\(definition mismatch\)/;
const BUILD_ERROR_RE = /boom building index/;

type ValidityRow = {
  name: string;
  valid: boolean;
  ready: boolean;
  unique: boolean;
  def: string;
};

const DEF_BY_NAME: Record<string, string> = {
  [GIN_IDX]: `CREATE INDEX ${GIN_IDX} ON s USING gin (tsv)`,
  [COMPOSITE_IDX]: `CREATE INDEX ${COMPOSITE_IDX} ON s USING btree (organization_id, entity_type, updated_at)`,
  [UNIQUE_IDX]: `CREATE UNIQUE INDEX ${UNIQUE_IDX} ON s USING btree (organization_id, entity_type, entity_id)`,
};

function usableRow(name: string): ValidityRow {
  return {
    name,
    valid: true,
    ready: true,
    unique: name === UNIQUE_IDX,
    def: DEF_BY_NAME[name],
  };
}

/**
 * Mock SqlClient modeling the query sequence: SET search_path, pg_advisory_lock,
 * a first INDEX_VALIDITY_SQL (drop-check → beforeRows), DROP/CREATE statements,
 * then a second INDEX_VALIDITY_SQL (verify → afterRows).
 */
function makeMockClient(
  opts: {
    beforeRows?: ValidityRow[];
    afterRows?: ValidityRow[];
    failBuild?: boolean;
  } = {}
) {
  const before = opts.beforeRows ?? [];
  const after = opts.afterRows ?? FEA3857_INDEX_NAMES.map(usableRow);
  const queries: { text: string; values?: unknown[] }[] = [];
  let validityCalls = 0;
  const client: SqlClient = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (VALIDITY_RE.test(text)) {
        validityCalls += 1;
        return Promise.resolve({ rows: validityCalls === 1 ? before : after });
      }
      if (opts.failBuild && CREATE_INDEX_RE.test(text)) {
        return Promise.reject(new Error("boom building index"));
      }
      return Promise.resolve({ rowCount: 0 });
    }),
  };
  return { client, queries };
}

describe("parsePlainIndexBuilds", () => {
  it("strips CONCURRENTLY, keeps UNIQUE, preserves IF NOT EXISTS, captures names + uniqueness", () => {
    const builds = parsePlainIndexBuilds(FEA3857_SQL);
    expect(builds.map((b) => b.name)).toEqual(FEA3857_INDEX_NAMES);
    expect(builds.map((b) => b.unique)).toEqual([false, false, true]);
    expect(builds.map((b) => b.columns)).toEqual([
      ["tsv"],
      ["organization_id", "entity_type", "updated_at"],
      ["organization_id", "entity_type", "entity_id"],
    ]);
    for (const build of builds) {
      expect(build.sql).not.toMatch(CONCURRENTLY_RE);
      expect(build.sql).toMatch(IF_NOT_EXISTS_RE);
    }
    expect(builds[2].sql).toMatch(CREATE_UNIQUE_INDEX_RE);
    expect(builds[0].sql).toContain('USING GIN ("tsv")');
  });

  it("forces IF NOT EXISTS when the source statement omits it", () => {
    const builds = parsePlainIndexBuilds(
      `CREATE INDEX CONCURRENTLY "foo_idx" ON "foo"("bar");`
    );
    expect(builds).toHaveLength(1);
    expect(builds[0].name).toBe("foo_idx");
    expect(builds[0].sql).toBe(
      `CREATE INDEX IF NOT EXISTS "foo_idx" ON "foo"("bar")`
    );
  });

  it("returns [] for a comment-only body (no executable statements)", () => {
    expect(
      parsePlainIndexBuilds("-- just an explanatory comment, no DDL")
    ).toEqual([]);
  });

  it("THROWS on any non-index executable fragment (a plain-build migration is index-only)", () => {
    // A DROP (or any table/data change) must not be silently skipped on preview,
    // because the whole migration is pre-stamped as applied.
    expect(() =>
      parsePlainIndexBuilds(
        `CREATE INDEX CONCURRENTLY "a_idx" ON "t"("a");
DROP INDEX "b_idx";`
      )
    ).toThrow(NON_INDEX_STATEMENT_RE);
  });

  it("throws (fail-closed) on a CONCURRENTLY-index statement whose name cannot be parsed", () => {
    expect(() =>
      parsePlainIndexBuilds(`CREATE INDEX CONCURRENTLY ON "t"("a");`)
    ).toThrow(CANNOT_PARSE_NAME_RE);
  });
});

describe("plainBuildPreviewConcurrentIndexes", () => {
  it("is a no-op for the public schema (no client created)", async () => {
    const createClient = vi.fn();
    await plainBuildPreviewConcurrentIndexes("postgres://x", "public", {
      createClient,
      readMigrationSql: readFea3857MigrationSql,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("is a no-op for a null schema (no client created)", async () => {
    const createClient = vi.fn();
    await plainBuildPreviewConcurrentIndexes("postgres://x", null, {
      createClient,
      readMigrationSql: readFea3857MigrationSql,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("sets search_path, takes the per-schema lock, builds each index plain, and verifies", async () => {
    const { client, queries } = makeMockClient();
    await plainBuildPreviewConcurrentIndexes("postgres://x", PREVIEW_SCHEMA, {
      createClient: () => client,
      readMigrationSql: readFea3857MigrationSql,
    });

    expect(queries[0].text).toBe(`SET search_path TO "${PREVIEW_SCHEMA}"`);
    const lock = queries.find((q) => ADVISORY_LOCK_RE.test(q.text));
    expect(lock?.values).toEqual([72_707_370, PREVIEW_SCHEMA]);
    const buildQueries = queries.filter((q) => CREATE_INDEX_RE.test(q.text));
    expect(buildQueries).toHaveLength(3);
    for (const q of buildQueries) {
      expect(q.text).not.toMatch(CONCURRENTLY_RE);
    }
    // Verify read back real index state from pg_index (twice: drop-check + verify).
    expect(queries.filter((q) => VALIDITY_RE.test(q.text))).toHaveLength(2);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("drops a pre-existing INVALID same-named index before rebuilding it", async () => {
    const { client, queries } = makeMockClient({
      beforeRows: [
        {
          name: UNIQUE_IDX,
          valid: false,
          ready: false,
          unique: true,
          def: DEF_BY_NAME[UNIQUE_IDX],
        },
      ],
    });
    await plainBuildPreviewConcurrentIndexes("postgres://x", PREVIEW_SCHEMA, {
      createClient: () => client,
      readMigrationSql: readFea3857MigrationSql,
    });
    const drop = queries.find((q) => DROP_INDEX_RE.test(q.text));
    expect(drop?.text).toContain(`"${PREVIEW_SCHEMA}"."${UNIQUE_IDX}"`);
  });

  it("drops a pre-existing VALID same-named index whose columns drifted, then rebuilds", async () => {
    const { client, queries } = makeMockClient({
      // Valid + ready + unique, but the definition is missing the entity_id key.
      beforeRows: [
        {
          name: UNIQUE_IDX,
          valid: true,
          ready: true,
          unique: true,
          def: `CREATE UNIQUE INDEX ${UNIQUE_IDX} ON s USING btree (organization_id, entity_type, wrong_col)`,
        },
      ],
    });
    await plainBuildPreviewConcurrentIndexes("postgres://x", PREVIEW_SCHEMA, {
      createClient: () => client,
      readMigrationSql: readFea3857MigrationSql,
    });
    const drop = queries.find((q) => DROP_INDEX_RE.test(q.text));
    expect(drop?.text).toContain(`"${PREVIEW_SCHEMA}"."${UNIQUE_IDX}"`);
  });

  it("throws (fail-closed) when an expected index is missing after building", async () => {
    const { client } = makeMockClient({
      afterRows: [GIN_IDX, COMPOSITE_IDX].map(usableRow), // UNIQUE_IDX absent
    });
    await expect(
      plainBuildPreviewConcurrentIndexes("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        readMigrationSql: readFea3857MigrationSql,
      })
    ).rejects.toThrow(NOT_USABLE_RE);
    await expect(
      plainBuildPreviewConcurrentIndexes("postgres://x", PREVIEW_SCHEMA, {
        createClient: () =>
          makeMockClient({ afterRows: [GIN_IDX, COMPOSITE_IDX].map(usableRow) })
            .client,
        readMigrationSql: readFea3857MigrationSql,
      })
    ).rejects.toThrow(MISSING_RE);
  });

  it("throws (fail-closed) when the UNIQUE index built as non-unique", async () => {
    const { client } = makeMockClient({
      afterRows: [
        usableRow(GIN_IDX),
        usableRow(COMPOSITE_IDX),
        {
          name: UNIQUE_IDX,
          valid: true,
          ready: true,
          unique: false,
          def: DEF_BY_NAME[UNIQUE_IDX],
        },
      ],
    });
    await expect(
      plainBuildPreviewConcurrentIndexes("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        readMigrationSql: readFea3857MigrationSql,
      })
    ).rejects.toThrow(NOT_UNIQUE_RE);
  });

  it("throws (fail-closed) when a built index is INVALID after building", async () => {
    const { client } = makeMockClient({
      afterRows: [
        {
          name: GIN_IDX,
          valid: false,
          ready: true,
          unique: false,
          def: DEF_BY_NAME[GIN_IDX],
        },
        usableRow(COMPOSITE_IDX),
        usableRow(UNIQUE_IDX),
      ],
    });
    await expect(
      plainBuildPreviewConcurrentIndexes("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        readMigrationSql: readFea3857MigrationSql,
      })
    ).rejects.toThrow(INVALID_RE);
  });

  it("throws (fail-closed) when a built index's definition does not match (wrong columns)", async () => {
    const { client } = makeMockClient({
      afterRows: [
        usableRow(GIN_IDX),
        usableRow(COMPOSITE_IDX),
        {
          name: UNIQUE_IDX,
          valid: true,
          ready: true,
          unique: true,
          def: `CREATE UNIQUE INDEX ${UNIQUE_IDX} ON s USING btree (organization_id, entity_type, wrong_col)`,
        },
      ],
    });
    await expect(
      plainBuildPreviewConcurrentIndexes("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        readMigrationSql: readFea3857MigrationSql,
      })
    ).rejects.toThrow(DEFINITION_MISMATCH_RE);
  });

  it("propagates a build error (fail-closed) and still closes the connection", async () => {
    const { client } = makeMockClient({ failBuild: true });
    await expect(
      plainBuildPreviewConcurrentIndexes("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        readMigrationSql: readFea3857MigrationSql,
      })
    ).rejects.toThrow(BUILD_ERROR_RE);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});

function readFea3857MigrationSql(migrationName: string): string {
  return migrationName === FEA3857_MIGRATION_NAME
    ? FEA3857_SQL
    : "-- Migration omitted from this FEA-3857-focused fixture.";
}
