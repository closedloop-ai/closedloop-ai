-- FEA-2923 (Gap A): restore hand-created org-custom agents to the Agents
-- workspace by backfilling them into `agent_components` (the table the new UI
-- reads via GET /agent-components → agentComponentsService.listForOrg).
--
-- BACKGROUND: #2570's migration 20260711010000_migrate_agents_to_catalog_items
-- copied legacy `agents` → `catalog_items` (target_kind='agent',
-- source='org_custom'). But the Agents UI reads `agent_components`, and nothing
-- bridged catalog_items → agent_components, so those custom agents had no UI.
-- This migration backfills them.
--
-- MODELING CHOICE (computeTargetId gap): AgentComponent.computeTargetId is an
-- FK-required, non-null column, and the table is deduped by
-- (compute_target_id, component_kind, external_component_id). Desktop component
-- sync upserts per-device rows keyed by the real device's compute_target_id.
-- Cloud-authored/bootstrap custom agents have NO device. Rather than make the
-- FK nullable (which would ripple nullable-handling through desktop sync,
-- listing, provenance, owner attribution, and the unique index), we introduce a
-- synthetic per-org "cloud" compute target (is_cloud_sentinel = true) that owns
-- these rows. Its distinct id isolates cloud rows from device sync: the desktop
-- upsert's (compute_target_id, ...) key uses the real device id and can never
-- collide with a sentinel-owned row. Device-facing compute-target listings
-- filter out is_cloud_sentinel rows.
--
-- IDEMPOTENCY: Safe to re-run. Both steps guard with WHERE NOT EXISTS.
-- Only org_custom target_kind='agent' catalog items are backfilled — curated /
-- global / marketplace catalog items and non-agent kinds are left untouched.
--
-- FORWARD-ONLY: No rollback path.

-- ============================================================================
-- Step 0 (DDL): add the is_cloud_sentinel marker column (Prisma-generated).
-- ============================================================================
-- AlterTable
ALTER TABLE "compute_targets" ADD COLUMN     "is_cloud_sentinel" BOOLEAN NOT NULL DEFAULT false;

-- ============================================================================
-- Step 1 (data): ensure one sentinel "cloud" compute target per org that has
-- at least one org_custom agent catalog item.
--
-- Owner (user_id): the org's earliest-created active user (deterministic tie-
-- break on id). user_id is a NOT NULL FK to users; the sentinel is org-owned in
-- spirit but must reference a concrete user. machine_name is a reserved literal
-- so the @@unique([user_id, machine_name]) constraint can never collide with a
-- real device for that user.
--
-- Guard: skip orgs that already have a sentinel (idempotent re-run) and orgs
-- with no eligible user (defensive — every org has users in practice).
-- ============================================================================
INSERT INTO compute_targets (
    id,
    organization_id,
    user_id,
    machine_name,
    platform,
    capabilities,
    supported_operations,
    last_seen_at,
    is_online,
    is_shared_with_org,
    is_cloud_sentinel,
    selected_harness,
    created_at,
    updated_at
)
SELECT
    gen_random_uuid()            AS id,
    o.organization_id,
    (
        SELECT u.id
        FROM users u
        WHERE u.organization_id = o.organization_id
          AND u.active = true
        ORDER BY u.created_at ASC, u.id ASC
        LIMIT 1
    )                            AS user_id,
    '__cloud_sentinel__'         AS machine_name,
    'cloud'                      AS platform,
    '{}'::jsonb                  AS capabilities,
    '[]'::jsonb                  AS supported_operations,
    CURRENT_TIMESTAMP            AS last_seen_at,
    false                        AS is_online,
    false                        AS is_shared_with_org,
    true                         AS is_cloud_sentinel,
    'claude'                     AS selected_harness,
    CURRENT_TIMESTAMP            AS created_at,
    CURRENT_TIMESTAMP            AS updated_at
FROM (
    SELECT DISTINCT ci.organization_id
    FROM catalog_items ci
    WHERE ci.target_kind = 'agent'
      AND ci.source = 'org_custom'
      AND ci.organization_id IS NOT NULL
) o
WHERE EXISTS (
    -- Only create a sentinel when the org has at least one active user to own it.
    SELECT 1 FROM users u
    WHERE u.organization_id = o.organization_id
      AND u.active = true
)
AND NOT EXISTS (
    SELECT 1 FROM compute_targets ct
    WHERE ct.organization_id = o.organization_id
      AND ct.is_cloud_sentinel = true
);

-- ============================================================================
-- Step 2 (data): backfill one agent_components row per org_custom agent
-- catalog item, owned by that org's sentinel compute target.
--
--   component_kind        = 'subagent'
--   external_component_id  = 'cloud:agent:' || COALESCE(legacy_agent_id, id)
--                            (deterministic; keys off the legacy agent id when
--                            present so re-migrated agents map to the same row,
--                            else the catalog item id for natively-created
--                            org_custom agents)
--   component_key / name   = catalog item's agent_slug / name
--   source_url             = catalog item's source_repo (or NULL when empty)
--   harness                = 'claude' (org agents are Claude subagents)
--
-- Idempotency: guarded on the (compute_target_id, component_kind,
-- external_component_id) unique key — the same key that desktop sync upserts on
-- — so a re-run inserts nothing and cannot conflict with device rows.
-- ============================================================================
INSERT INTO agent_components (
    id,
    organization_id,
    compute_target_id,
    component_kind,
    external_component_id,
    harness,
    name,
    component_key,
    version,
    description,
    source_url,
    scope,
    metadata,
    first_seen_at,
    last_seen_at,
    created_at,
    updated_at
)
SELECT
    gen_random_uuid()                                   AS id,
    ci.organization_id,
    sentinel.id                                         AS compute_target_id,
    'subagent'                                          AS component_kind,
    'cloud:agent:' || COALESCE(ci.legacy_agent_id::text, ci.id::text)
                                                        AS external_component_id,
    'claude'                                            AS harness,
    ci.name,
    -- Prefer the disambiguated agent_slug (stable harness file name); fall back
    -- to name so the org-identity dedup in listForOrg (kind::key) has a key.
    COALESCE(ci.agent_slug, ci.name)                    AS component_key,
    ci.version,
    ci.description,
    NULLIF(ci.source_repo, '')                          AS source_url,
    'org'                                               AS scope,
    jsonb_build_object(
        'cloudAuthored', true,
        'catalogItemId', ci.id,
        'legacyAgentId', ci.legacy_agent_id,
        'source', 'org_custom'
    )                                                   AS metadata,
    ci.created_at                                       AS first_seen_at,
    ci.updated_at                                       AS last_seen_at,
    CURRENT_TIMESTAMP                                   AS created_at,
    CURRENT_TIMESTAMP                                   AS updated_at
FROM catalog_items ci
JOIN compute_targets sentinel
    ON sentinel.organization_id = ci.organization_id
   AND sentinel.is_cloud_sentinel = true
WHERE ci.target_kind = 'agent'
  AND ci.source = 'org_custom'
  AND ci.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_components ac
    WHERE ac.compute_target_id = sentinel.id
      AND ac.component_kind = 'subagent'
      AND ac.external_component_id =
          'cloud:agent:' || COALESCE(ci.legacy_agent_id::text, ci.id::text)
  );
