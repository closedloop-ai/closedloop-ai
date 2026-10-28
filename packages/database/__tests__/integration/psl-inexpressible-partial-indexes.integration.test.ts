import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";

/**
 * ISS-7476 — the partial indexes Prisma still cannot see, and therefore cannot
 * protect.
 *
 * Since the `partialIndexes` preview feature was enabled, every partial index
 * whose key columns PSL can express is declared in `schema.prisma` with
 * `where: raw(...)`, and the CI "Verify Prisma dev drift" job fails if one is
 * added without a declaration or removed without a migration.
 *
 * The indexes below are partial AND EXPRESSION indexes (`lower(...)`,
 * `COALESCE(...)`). PSL cannot express an expression key at all, so `db pull`
 * reports them as unsupported and the differ ignores them entirely — they are
 * invisible to the flag in both directions. They live only in migration SQL,
 * and nothing else in the repo would notice if a `CREATE INDEX` statement were
 * dropped, renamed, or had its key or predicate quietly changed. This suite is
 * the guard that replaces the differ for them.
 *
 * It runs against a real Postgres that has had `prisma migrate deploy` applied,
 * so the objects under test are the ones the migrations actually create.
 */

type InexpressibleIndex = {
  /** Index name, as the migration creates it. */
  readonly name: string;
  /** Table the index is built on. */
  readonly table: string;
  /** Migration that owns the statement. */
  readonly migration: string;
  /** Key fragments that must appear in `indexdef`, expression included. */
  readonly keyFragments: readonly string[];
  /** The partial predicate, verbatim as Postgres normalizes it. */
  readonly predicate: string;
  /** Whether the index is UNIQUE (a lost UNIQUE is a lost invariant). */
  readonly unique: boolean;
};

/**
 * The COMPLETE set of partial expression indexes in the schema. The first case
 * below reads the catalog and asserts equality against these names, so a new
 * hand-written one fails here until it is listed — and an entry that becomes
 * declarable in PSL (an expression key Prisma learns to express) must be moved
 * into `schema.prisma` and deleted from this list.
 */
const INEXPRESSIBLE_INDEXES: readonly InexpressibleIndex[] = [
  {
    name: "artifact_activity_events_monitored_retained_target_idx",
    table: "artifact_activity_events",
    migration: "20261013120000_monitored_retained_target_index",
    keyFragments: [
      "organization_id",
      "artifact_id",
      "((after ->> 'kind'::text))",
      "((after ->> 'repositoryFullName'::text))",
      "COALESCE((after ->> 'branchName'::text), (after ->> 'prNumber'::text))",
    ],
    predicate: "WHERE (action = 'monitored_activity_retained'::text)",
    unique: false,
  },
  {
    name: "github_installation_repositories_inst_lower_full_name_idx",
    table: "github_installation_repositories",
    migration: "20260815120000_iss6452_repository_authority_lower_name_indexes",
    keyFragments: ["installation_id", "lower(full_name)"],
    predicate: "WHERE (removed_at IS NULL)",
    unique: false,
  },
  {
    name: "pull_request_detail_org_lower_head_repo_full_name_idx",
    table: "pull_request_detail",
    migration: "20260815120000_iss6452_repository_authority_lower_name_indexes",
    keyFragments: ["organization_id", "lower(head_repository_full_name)"],
    predicate: "WHERE (head_repository_full_name IS NOT NULL)",
    unique: false,
  },
  {
    name: "search_document_org_lower_slug_idx",
    table: "search_document",
    migration: "20260724010000_fea3930_search_document_slug_lookup_index",
    keyFragments: ["organization_id", "lower(slug)"],
    predicate: "WHERE (slug IS NOT NULL)",
    unique: false,
  },
  {
    name: "idx_source_occurrence_null_target_natural_key",
    table: "source_occurrences",
    migration: "20260723200300_fea_3294_agent_component_invocations",
    keyFragments: [
      "definition_version_id",
      "occurrence_type",
      "COALESCE(repo_full_name, ''::text)",
      "COALESCE(repo_path, ''::text)",
      "COALESCE(repo_commit, ''::text)",
      "COALESCE(local_path, ''::text)",
      "COALESCE(pack_id, ''::text)",
    ],
    predicate: "WHERE (compute_target_id IS NULL)",
    unique: true,
  },
];

/**
 * Partial (`indpred`) AND expression (`indexprs`) indexes in the connection's
 * schema. Both catalog columns are how Postgres itself distinguishes the two
 * properties, so this cannot drift from a textual guess about `indexdef`.
 */
const PARTIAL_EXPRESSION_INDEX_SQL = `SELECT index_class.relname AS name,
       table_class.relname AS "table",
       pg_get_indexdef(index_rel.indexrelid) AS indexdef
  FROM pg_index AS index_rel
  JOIN pg_class AS index_class ON index_class.oid = index_rel.indexrelid
  JOIN pg_class AS table_class ON table_class.oid = index_rel.indrelid
  JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
 WHERE namespace.nspname = current_schema()
   AND index_rel.indpred IS NOT NULL
   AND index_rel.indexprs IS NOT NULL
 ORDER BY index_class.relname`;

type CatalogIndexRow = { name: string; table: string; indexdef: string };

describe.skipIf(!process.env.DATABASE_URL)(
  "partial expression indexes PSL cannot declare (integration)",
  () => {
    let ctx: EphemeralDbContext;
    let catalogRows: CatalogIndexRow[];

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      catalogRows = await ctx.prisma.$queryRawUnsafe<CatalogIndexRow[]>(
        PARTIAL_EXPRESSION_INDEX_SQL
      );
    }, 120_000);

    afterAll(async () => {
      if (ctx) {
        await teardownEphemeralDb(ctx);
      }
    }, 120_000);

    it("has exactly the listed partial expression indexes, so a new one cannot arrive unguarded", () => {
      const expectedNames = INEXPRESSIBLE_INDEXES.map((index) => index.name);
      expectedNames.sort();

      expect(catalogRows.map((row) => row.name)).toEqual(expectedNames);
    });

    it.each(INEXPRESSIBLE_INDEXES)(
      "$name still carries its expression key and partial predicate",
      ({ name, table, migration, keyFragments, predicate, unique }) => {
        const row = catalogRows.find((candidate) => candidate.name === name);

        expect(
          row,
          `${name} is missing — migration ${migration} is the only place it is created`
        ).toBeDefined();
        expect(row?.table).toBe(table);

        for (const fragment of keyFragments) {
          expect(row?.indexdef).toContain(fragment);
        }
        expect(row?.indexdef).toContain(predicate);
        expect(row?.indexdef?.includes("CREATE UNIQUE INDEX")).toBe(unique);
      }
    );
  }
);
