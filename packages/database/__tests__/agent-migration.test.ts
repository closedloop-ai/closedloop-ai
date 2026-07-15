/**
 * Migration correctness tests for Agent/AgentVersion → CatalogItem/CatalogItemVersion
 * (T-21.5a — AC-027, AC-028).
 *
 * These are SQL-inspection tests: they validate the data migration file
 * without requiring a live database, following the same pattern as
 * `check-run-retry-migration.test.ts`. Integration tests that actually run
 * the migration against a real Postgres database live in `__tests__/integration/`.
 *
 * Covered:
 * - All required fields are SELECTed from `agents` and inserted into `catalog_items`
 * - `legacy_agent_id` traceability column is set to `a.id`
 * - `target_kind = 'agent'`, `source = 'org_custom'`, `scope = 'org'`
 * - Idempotency guard (WHERE NOT EXISTS) prevents duplicate catalog_items
 * - AgentVersion → CatalogItemVersion joins via `legacy_agent_id`
 * - CatalogItemVersion idempotency guard prevents duplicate versions
 * - `RepoBootstrapConfig` table (`repo_bootstrap_configs`) is NOT touched by either step
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20260711010000_migrate_agents_to_catalog_items/migration.sql"
);

// ---------------------------------------------------------------------------
// Top-level regex constants (biome: useTopLevelRegex)
// ---------------------------------------------------------------------------

const AGENT_TARGET_KIND_PATTERN = /'agent'\s+AS target_kind/;
const ORG_CUSTOM_SOURCE_PATTERN = /'org_custom'\s+AS source/;
const ORG_SCOPE_PATTERN = /'org'\s+AS scope/;
const LEGACY_AGENT_ID_MAPPED_PATTERN = /a\.id\s+AS legacy_agent_id/;
const ARCHIVED_FALSE_PATTERN = /false\s+AS archived/;
const WHERE_NOT_EXISTS_CATALOG_ITEMS_PATTERN =
  /WHERE NOT EXISTS\s*\(\s*SELECT 1\s*FROM catalog_items/s;
const LEGACY_AGENT_ID_JOIN_PATTERN = /ci\.legacy_agent_id\s*=\s*a\.id/;
const CATALOG_ITEMS_JOIN_PATTERN =
  /JOIN catalog_items ci\s+ON ci\.legacy_agent_id\s*=\s*a\.id/;
const PROMPT_AS_CONTENT_PATTERN = /av\.prompt\s+AS content/;
const WHERE_NOT_EXISTS_VERSIONS_PATTERN =
  /WHERE NOT EXISTS\s*\(\s*SELECT 1\s*FROM catalog_item_versions/s;
const CATALOG_ITEM_VERSION_JOIN_PATTERN = /civ\.catalog_item_id\s*=\s*ci\.id/;
const VERSION_MATCH_PATTERN = /AND\s+civ\.version\s*=\s*av\.version/;
const REPO_BOOTSTRAP_CONFIGS_PATTERN = /repo_bootstrap_configs/i;

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

// ---------------------------------------------------------------------------
// Step 1: Agent → CatalogItem
// ---------------------------------------------------------------------------

describe("Agent → CatalogItem migration (Step 1)", () => {
  it("inserts into catalog_items from agents", () => {
    const sql = readMigration();
    expect(sql).toContain("INSERT INTO catalog_items");
    expect(sql).toContain("FROM agents");
  });

  it("sets target_kind to 'agent'", () => {
    const sql = readMigration();
    expect(sql).toMatch(AGENT_TARGET_KIND_PATTERN);
  });

  it("sets source to 'org_custom'", () => {
    const sql = readMigration();
    expect(sql).toMatch(ORG_CUSTOM_SOURCE_PATTERN);
  });

  it("sets scope to 'org'", () => {
    const sql = readMigration();
    expect(sql).toMatch(ORG_SCOPE_PATTERN);
  });

  it("maps legacy_agent_id to a.id for migration traceability", () => {
    const sql = readMigration();
    expect(sql).toMatch(LEGACY_AGENT_ID_MAPPED_PATTERN);
    expect(sql).toContain("legacy_agent_id");
  });

  it("preserves organization_id field mapping", () => {
    const sql = readMigration();
    expect(sql).toContain("a.organization_id");
    expect(sql).toContain("organization_id");
  });

  it("preserves source_repo field mapping", () => {
    const sql = readMigration();
    expect(sql).toContain("a.source_repo");
  });

  it("preserves role field mapping", () => {
    const sql = readMigration();
    expect(sql).toContain("a.role");
  });

  it("preserves enabled field mapping", () => {
    const sql = readMigration();
    expect(sql).toContain("a.enabled");
  });

  it("sets archived = false for all migrated rows", () => {
    const sql = readMigration();
    expect(sql).toMatch(ARCHIVED_FALSE_PATTERN);
  });

  it("maps bootstrap_run_id to source_loop_id", () => {
    const sql = readMigration();
    expect(sql).toContain("a.bootstrap_run_id");
    expect(sql).toContain("source_loop_id");
  });

  it("has an idempotency guard (WHERE NOT EXISTS) to prevent duplicates", () => {
    const sql = readMigration();
    expect(sql).toMatch(WHERE_NOT_EXISTS_CATALOG_ITEMS_PATTERN);
  });

  it("idempotency guard matches on legacy_agent_id = a.id", () => {
    const sql = readMigration();
    expect(sql).toMatch(LEGACY_AGENT_ID_JOIN_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// Step 2: AgentVersion → CatalogItemVersion
// ---------------------------------------------------------------------------

describe("AgentVersion → CatalogItemVersion migration (Step 2)", () => {
  it("inserts into catalog_item_versions from agent_versions", () => {
    const sql = readMigration();
    expect(sql).toContain("INSERT INTO catalog_item_versions");
    expect(sql).toContain("FROM agent_versions av");
  });

  it("joins agent_versions → agents → catalog_items via legacy_agent_id", () => {
    const sql = readMigration();
    expect(sql).toContain("JOIN agents a");
    expect(sql).toMatch(CATALOG_ITEMS_JOIN_PATTERN);
  });

  it("maps prompt to content field", () => {
    const sql = readMigration();
    expect(sql).toMatch(PROMPT_AS_CONTENT_PATTERN);
  });

  it("preserves version number", () => {
    const sql = readMigration();
    expect(sql).toContain("av.version");
  });

  it("preserves change_note field", () => {
    const sql = readMigration();
    expect(sql).toContain("av.change_note");
  });

  it("has an idempotency guard (WHERE NOT EXISTS) to prevent duplicate versions", () => {
    const sql = readMigration();
    expect(sql).toMatch(WHERE_NOT_EXISTS_VERSIONS_PATTERN);
  });

  it("idempotency guard matches on (catalog_item_id, version)", () => {
    const sql = readMigration();
    expect(sql).toMatch(CATALOG_ITEM_VERSION_JOIN_PATTERN);
    expect(sql).toMatch(VERSION_MATCH_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// RepoBootstrapConfig: must NOT be touched
// ---------------------------------------------------------------------------

describe("RepoBootstrapConfig untouched invariant", () => {
  it("does not reference repo_bootstrap_configs table anywhere in the migration", () => {
    const sql = readMigration();
    expect(sql).not.toMatch(REPO_BOOTSTRAP_CONFIGS_PATTERN);
  });
});
