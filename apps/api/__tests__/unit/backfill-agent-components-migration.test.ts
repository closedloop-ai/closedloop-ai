import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FEA-2923 (Gap A) — contract coverage for the migration that backfills
 * org-custom agents (previously copied into `catalog_items` by #2570) into
 * `agent_components`, the table the Agents UI reads.
 *
 * These assertions pin the load-bearing SQL invariants so a future edit can't
 * silently regress them:
 *  - the is_cloud_sentinel marker column DDL
 *  - a per-org sentinel compute target owns the cloud rows (keeps the FK
 *    non-null; isolated from device sync)
 *  - only org_custom target_kind='agent' catalog items are backfilled
 *  - deterministic external_component_id keyed off the legacy agent id
 *  - both steps are idempotent (WHERE NOT EXISTS guards)
 */
const migrationPath = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/prisma/migrations/20260712000000_add_compute_target_cloud_sentinel_and_backfill_agent_components/migration.sql"
);
const schemaPath = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/prisma/schema.prisma"
);

const sql = readFileSync(migrationPath, "utf-8");

// Hoisted to module scope (lint/performance/useTopLevelRegex).
const SENTINEL_COLUMN_DDL =
  /ALTER TABLE "compute_targets" ADD COLUMN\s+"is_cloud_sentinel" BOOLEAN NOT NULL DEFAULT false/;
const INSERT_COMPUTE_TARGETS = /INSERT INTO compute_targets/;
const SENTINEL_FLAG_SELECT = /true\s+AS is_cloud_sentinel/;
const EARLIEST_USER_ORDER = /ORDER BY u\.created_at ASC, u\.id ASC\s+LIMIT 1/;
const TARGET_KIND_AGENT = /ci\.target_kind = 'agent'/;
const SOURCE_ORG_CUSTOM = /ci\.source = 'org_custom'/;
const ORG_ID_NOT_NULL = /ci\.organization_id IS NOT NULL/;
const SUBAGENT_KIND = /'subagent'\s+AS component_kind/;
const DETERMINISTIC_EXTERNAL_ID =
  /'cloud:agent:' \|\| COALESCE\(ci\.legacy_agent_id::text, ci\.id::text\)/;
const COMPONENT_KEY_FROM_SLUG =
  /COALESCE\(ci\.agent_slug, ci\.name\)\s+AS component_key/;
const SOURCE_URL_FROM_REPO = /NULLIF\(ci\.source_repo, ''\)\s+AS source_url/;
const SENTINEL_EXISTS_GUARD =
  /NOT EXISTS[\s\S]*FROM compute_targets ct[\s\S]*is_cloud_sentinel = true/;
const AGENT_COMPONENTS_EXISTS_GUARD =
  /NOT EXISTS[\s\S]*FROM agent_components ac[\s\S]*ac\.compute_target_id = sentinel\.id[\s\S]*ac\.component_kind = 'subagent'[\s\S]*ac\.external_component_id =/;

describe("backfill org-custom agents into agent_components migration", () => {
  it("adds the is_cloud_sentinel marker column with a false default", () => {
    expect(sql).toMatch(SENTINEL_COLUMN_DDL);
  });

  it("creates a per-org sentinel compute target flagged is_cloud_sentinel", () => {
    expect(sql).toMatch(INSERT_COMPUTE_TARGETS);
    // Sentinel rows are marked so device-facing listings can exclude them.
    expect(sql).toMatch(SENTINEL_FLAG_SELECT);
    // Reserved machine_name so @@unique([user_id, machine_name]) never collides.
    expect(sql).toContain("'__cloud_sentinel__'");
    expect(sql).toContain("'cloud'                      AS platform");
  });

  it("owns the sentinel with the org's earliest active user", () => {
    expect(sql).toContain("FROM users u");
    expect(sql).toContain("u.active = true");
    expect(sql).toMatch(EARLIEST_USER_ORDER);
  });

  it("only backfills org_custom target_kind='agent' catalog items", () => {
    expect(sql).toMatch(TARGET_KIND_AGENT);
    expect(sql).toMatch(SOURCE_ORG_CUSTOM);
    // Must not sweep global/curated (organization_id IS NULL) rows.
    expect(sql).toMatch(ORG_ID_NOT_NULL);
  });

  it("writes subagent rows with a deterministic legacy-keyed external id", () => {
    expect(sql).toMatch(SUBAGENT_KIND);
    expect(sql).toMatch(DETERMINISTIC_EXTERNAL_ID);
  });

  it("maps name/slug/source_repo onto the inventory row", () => {
    expect(sql).toMatch(COMPONENT_KEY_FROM_SLUG);
    expect(sql).toMatch(SOURCE_URL_FROM_REPO);
  });

  it("keys the backfill onto the desktop-sync unique key and guards re-runs", () => {
    // Idempotency: sentinel creation guarded, and the agent_components insert
    // guarded on the exact (compute_target_id, component_kind,
    // external_component_id) triple desktop sync upserts on — so a re-run is a
    // no-op and can never collide with a real device's rows.
    expect(sql).toMatch(SENTINEL_EXISTS_GUARD);
    expect(sql).toMatch(AGENT_COMPONENTS_EXISTS_GUARD);
  });

  it("declares is_cloud_sentinel on the ComputeTarget model", () => {
    const schema = readFileSync(schemaPath, "utf-8");
    expect(schema).toContain(
      'isCloudSentinel        Boolean   @default(false) @map("is_cloud_sentinel")'
    );
  });
});
