-- Org-scoped composite indexes replace these older unscoped indexes.
DROP INDEX IF EXISTS "entity_links_source_id_source_type_link_type_idx";
DROP INDEX IF EXISTS "entity_links_target_id_target_type_link_type_idx";
