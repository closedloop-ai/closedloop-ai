-- Data Migration: Agent/AgentVersion → CatalogItem/CatalogItemVersion (T-21.1)
--
-- PURPOSE: Migrate all existing org-authored Agent + AgentVersion rows into the
-- new CatalogItem + CatalogItemVersion model. This supersedes the Agent model
-- (see existing-agents-supersede.md) by populating CatalogItem with
-- targetKind='agent', source='org_custom', scope='org'. The legacy_agent_id
-- column on catalog_items provides traceability and idempotency — rows are
-- SKIPPED if a CatalogItem with the same legacy_agent_id already exists.
--
-- IDEMPOTENCY: Safe to re-run. The INSERT ... WHERE NOT EXISTS guards prevent
-- duplicates on re-application.
--
-- PRESERVED SEMANTICS:
--   - (organization_id, source_repo, role) partial unique index on catalog_items
--     WHERE target_kind = 'agent' mirrors Agent's bootstrap idempotency constraint.
--     This index was created in migration 20260711000000.
--   - RepoBootstrapConfig rows are NOT touched — left in place per the design.
--   - Agent and AgentVersion tables are NOT dropped; they remain as legacy
--     read-only tables until a follow-up migration removes them once CatalogItem
--     is the verified SSOT.
--
-- FORWARD-ONLY: No rollback path. Disabling AGENTS_FEATURE_FLAG_KEY is the
-- rollback mechanism for the application layer.

-- ============================================================================
-- Step 1: Migrate Agent rows → catalog_items
-- For each Agent that does NOT yet have a corresponding CatalogItem
-- (guard: legacy_agent_id IS NULL match or the target CatalogItem is absent).
-- ============================================================================
INSERT INTO catalog_items (
    id,
    organization_id,
    target_kind,
    source,
    scope,
    name,
    description,
    version,
    sort_order,
    enabled,
    archived,
    legacy_agent_id,
    source_repo,
    role,
    agent_slug,
    source_loop_id,
    created_by_id,
    created_at,
    updated_at
)
SELECT
    gen_random_uuid()        AS id,
    a.organization_id,
    'agent'                  AS target_kind,
    'org_custom'             AS source,
    'org'                    AS scope,
    a.name,
    a.description,
    -- Store currentVersion as semver string: "1.0.{currentVersion}"
    -- so it round-trips cleanly with the catalog version string format.
    '1.0.' || a.current_version::text AS version,
    0                        AS sort_order,
    a.enabled,
    false                    AS archived,
    a.id                     AS legacy_agent_id,
    a.source_repo,
    a.role,
    -- Carry over the already-disambiguated Agent.slug so migrated agents keep
    -- their existing harness file names and same-role/different-repo agents
    -- stay distinct (FEA-2923 supersede slug-collision fix).
    a.slug                   AS agent_slug,
    a.bootstrap_run_id       AS source_loop_id,
    a.created_by_id,
    a.created_at,
    a.updated_at
FROM agents a
WHERE NOT EXISTS (
    SELECT 1
    FROM catalog_items ci
    WHERE ci.legacy_agent_id = a.id
);

-- ============================================================================
-- Step 2: Migrate AgentVersion rows → catalog_item_versions
-- Join via legacy_agent_id to resolve the new catalog_item FK.
-- Skip rows where a catalog_item_version already exists for
-- (catalog_item_id, version) — idempotency guard.
-- ============================================================================
INSERT INTO catalog_item_versions (
    id,
    catalog_item_id,
    version,
    name,
    content,
    change_note,
    changed_by_id,
    created_at
)
SELECT
    gen_random_uuid()        AS id,
    ci.id                    AS catalog_item_id,
    av.version,
    av.name,
    av.prompt                AS content,
    av.change_note,
    av.changed_by_id,
    av.created_at
FROM agent_versions av
JOIN agents a          ON a.id = av.agent_id
JOIN catalog_items ci  ON ci.legacy_agent_id = a.id
WHERE NOT EXISTS (
    SELECT 1
    FROM catalog_item_versions civ
    WHERE civ.catalog_item_id = ci.id
      AND civ.version = av.version
);
