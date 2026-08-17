-- FEA-4335: index the content-hash detail/trend routing lookups.
--
-- The content-hash detail route resolves an identity by (organization_id,
-- component_kind, content_hash) on both the version table
-- (resolveContentHashIdentity's coarse fallback) and the inventory table
-- (resolveInventoryContentIdentity + the detail inventory read). The existing
-- leading indexes are keyed (org, kind, component_key) / (org, kind), which
-- cannot serve a content_hash predicate without the key, so each hash-route
-- request scanned the whole same-kind history/tombstone slice. These composite
-- indexes serve the hash lookup directly.
CREATE INDEX "agent_component_versions_org_kind_content_hash_idx"
  ON "agent_component_versions" ("organization_id", "component_kind", "content_hash");

CREATE INDEX "agent_components_org_kind_content_hash_idx"
  ON "agent_components" ("organization_id", "component_kind", "content_hash");
