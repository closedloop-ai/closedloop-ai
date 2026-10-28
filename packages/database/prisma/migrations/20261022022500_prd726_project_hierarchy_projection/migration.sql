-- PRD-726: move canonical hierarchy resolution from every bounded read to the
-- statement that changes a project's artifacts or PRODUCES links.
ALTER TABLE "projects"
  ADD COLUMN "hierarchy_version" TEXT NOT NULL DEFAULT '54b7ae02659c70d4cfc6c47f172e519b',
  ADD COLUMN "hierarchy_mutation_version" TEXT NOT NULL DEFAULT 'e3b0c44298fc1c149afbf4c8996fb924';

ALTER TABLE "artifacts"
  ADD COLUMN "canonical_parent_id" UUID,
  ADD COLUMN "hierarchy_rank" INTEGER,
  ADD COLUMN "canonical_child_count" BIGINT NOT NULL DEFAULT 0;

CREATE FUNCTION refresh_project_hierarchy_projection(project_uuid UUID)
RETURNS VOID
LANGUAGE plpgsql
-- Measured: once plpgsql moved these per-project statements to a generic
-- plan (after five calls in a session), a 12-row insert took 23 s instead of
-- 0.3 s.
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  project_organization_uuid UUID;
  hierarchy_seed TEXT;
  mutation_seed TEXT;
  is_acyclic BOOLEAN;
  parent_child_ids UUID[];
  parent_parent_ids UUID[];
  parent_sort_orders INTEGER[];
BEGIN
  -- The project rank advisory lock (lockProjectRank, document-sort-order.ts)
  -- serializes refreshes. A row lock here would deadlock against the KEY SHARE
  -- an artifact insert's foreign-key check takes on this same projects row, and
  -- writers that already hold the rank lock re-enter it.
  PERFORM pg_advisory_xact_lock(8999, hashtext(project_uuid::text));
  SELECT organization_id INTO project_organization_uuid
  FROM projects
  WHERE id = project_uuid;
  IF project_organization_uuid IS NULL THEN
    RETURN;
  END IF;

  -- The ordered walk below refuses a child's first candidate (canonical edges
  -- first, then creation order) only when it closes a cycle. When those first
  -- candidates form no cycle the walk refuses none of them, so this linear
  -- projection is its exact result, and the quadratic walk runs only for a
  -- project still holding a cycle written before cycle admission existed.
  WITH RECURSIVE scoped_artifacts AS (
    SELECT id
    FROM artifacts
    WHERE organization_id = project_organization_uuid
      AND project_id = project_uuid
  ),
  first_candidates AS (
    SELECT DISTINCT ON (link.target_id)
      link.target_id AS child_id,
      link.source_id AS parent_id,
      link.sort_order
    FROM artifact_links link
    JOIN scoped_artifacts source ON source.id = link.source_id
    JOIN scoped_artifacts target ON target.id = link.target_id
    WHERE link.organization_id = project_organization_uuid
      AND link.link_type = 'PRODUCES'::"LinkType"
      AND NOT COALESCE((
        jsonb_typeof(link.metadata #> '{hierarchy,suppressed}') = 'boolean'
        AND link.metadata #>> '{hierarchy,suppressed}' = 'true'
      ), false)
    ORDER BY
      link.target_id,
      COALESCE((
        jsonb_typeof(link.metadata #> '{hierarchy,canonical}') = 'boolean'
        AND link.metadata #>> '{hierarchy,canonical}' = 'true'
      ), false) DESC,
      link.created_at ASC,
      link.id ASC
  ),
  reachable AS (
    SELECT artifact.id
    FROM scoped_artifacts artifact
    WHERE NOT EXISTS (
      SELECT 1 FROM first_candidates candidate
      WHERE candidate.child_id = artifact.id
    )
    UNION ALL
    SELECT candidate.child_id
    FROM first_candidates candidate
    JOIN reachable ON reachable.id = candidate.parent_id
  )
  SELECT
    (SELECT count(*) FROM reachable) = (SELECT count(*) FROM scoped_artifacts),
    (SELECT array_agg(child_id ORDER BY child_id) FROM first_candidates),
    (SELECT array_agg(parent_id ORDER BY child_id) FROM first_candidates),
    (SELECT array_agg(sort_order ORDER BY child_id) FROM first_candidates)
  INTO is_acyclic, parent_child_ids, parent_parent_ids, parent_sort_orders;

  IF NOT is_acyclic THEN
    WITH RECURSIVE scoped_artifacts AS (
      SELECT id, project_id, type, subtype, sort_order, created_at
      FROM artifacts
      WHERE organization_id = project_organization_uuid
        AND project_id = project_uuid
    ),
    link_candidates AS (
      SELECT
        link.id AS link_id,
        link.created_at AS link_created_at,
        link.source_id,
        link.target_id,
        link.sort_order,
        min(link.created_at) OVER (PARTITION BY link.target_id) AS first_candidate_at,
        COALESCE((
          jsonb_typeof(link.metadata #> '{hierarchy,canonical}') = 'boolean'
          AND link.metadata #>> '{hierarchy,canonical}' = 'true'
        ), false) AS is_canonical,
        COALESCE((
          jsonb_typeof(link.metadata #> '{hierarchy,suppressed}') = 'boolean'
          AND link.metadata #>> '{hierarchy,suppressed}' = 'true'
        ), false) AS is_suppressed
      FROM artifact_links link
      JOIN scoped_artifacts source ON source.id = link.source_id
      JOIN scoped_artifacts target ON target.id = link.target_id
      WHERE link.organization_id = project_organization_uuid
        AND link.link_type = 'PRODUCES'::"LinkType"
    ),
    ordered_links AS (
      SELECT
        row_number() OVER (
          ORDER BY
            CASE WHEN is_canonical THEN first_candidate_at ELSE link_created_at END ASC,
            is_canonical DESC,
            link_created_at ASC,
            link_id ASC
        ) AS link_index,
        link_candidates.*
      FROM link_candidates
    ),
    resolved_links AS (
      SELECT
        0::bigint AS link_index,
        ARRAY[]::uuid[] AS child_ids,
        ARRAY[]::uuid[] AS parent_ids,
        ARRAY[]::uuid[] AS link_ids
      UNION ALL
      SELECT
        link.link_index,
        CASE WHEN decision.accepted
          THEN array_append(resolved_links.child_ids, link.target_id)
          ELSE resolved_links.child_ids
        END,
        CASE WHEN decision.accepted
          THEN array_append(resolved_links.parent_ids, link.source_id)
          ELSE resolved_links.parent_ids
        END,
        CASE WHEN decision.accepted
          THEN array_append(resolved_links.link_ids, link.link_id)
          ELSE resolved_links.link_ids
        END
      FROM resolved_links
      JOIN ordered_links link ON link.link_index = resolved_links.link_index + 1
      CROSS JOIN LATERAL (
        WITH RECURSIVE ancestor_chain AS (
          SELECT link.source_id AS artifact_id, ARRAY[link.source_id] AS visited
          UNION ALL
          SELECT
            resolved_links.parent_ids[
              array_position(resolved_links.child_ids, ancestor_chain.artifact_id)
            ],
            array_append(
              ancestor_chain.visited,
              resolved_links.parent_ids[
                array_position(resolved_links.child_ids, ancestor_chain.artifact_id)
              ]
            )
          FROM ancestor_chain
          WHERE array_position(resolved_links.child_ids, ancestor_chain.artifact_id) IS NOT NULL
            AND NOT resolved_links.parent_ids[
              array_position(resolved_links.child_ids, ancestor_chain.artifact_id)
            ] = ANY(ancestor_chain.visited)
        )
        SELECT
          NOT link.is_suppressed
          AND array_position(resolved_links.child_ids, link.target_id) IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ancestor_chain WHERE artifact_id = link.target_id
          ) AS accepted
      ) decision
    ),
    canonical_parents AS (
      SELECT edge.child_id, edge.parent_id, link.sort_order
      FROM (
        SELECT child_ids, parent_ids, link_ids
        FROM resolved_links ORDER BY link_index DESC LIMIT 1
      ) final
      CROSS JOIN LATERAL unnest(final.child_ids, final.parent_ids, final.link_ids)
        AS edge(child_id, parent_id, link_id)
      JOIN ordered_links link ON link.link_id = edge.link_id
    )
    SELECT
      array_agg(child_id ORDER BY child_id),
      array_agg(parent_id ORDER BY child_id),
      array_agg(sort_order ORDER BY child_id)
    INTO parent_child_ids, parent_parent_ids, parent_sort_orders
    FROM canonical_parents;
  END IF;

  WITH scoped_artifacts AS (
    SELECT id, sort_order
    FROM artifacts
    WHERE organization_id = project_organization_uuid
      AND project_id = project_uuid
  ),
  canonical_parents AS (
    SELECT edge.child_id, edge.parent_id, edge.sort_order
    FROM unnest(
      COALESCE(parent_child_ids, ARRAY[]::uuid[]),
      COALESCE(parent_parent_ids, ARRAY[]::uuid[]),
      COALESCE(parent_sort_orders, ARRAY[]::integer[])
    ) AS edge(child_id, parent_id, sort_order)
  ),
  child_counts AS (
    SELECT parent_id, count(*) AS child_count
    FROM canonical_parents
    GROUP BY parent_id
  ),
  projected AS (
    SELECT
      artifact.id,
      parent.parent_id,
      CASE WHEN parent.child_id IS NULL
        THEN artifact.sort_order ELSE parent.sort_order END AS rank,
      COALESCE(child_counts.child_count, 0) AS child_count
    FROM scoped_artifacts artifact
    LEFT JOIN canonical_parents parent ON parent.child_id = artifact.id
    LEFT JOIN child_counts ON child_counts.parent_id = artifact.id
  )
  UPDATE artifacts artifact
  SET canonical_parent_id = projected.parent_id,
      hierarchy_rank = projected.rank,
      canonical_child_count = projected.child_count
  FROM projected
  WHERE artifact.id = projected.id
    AND (
      artifact.canonical_parent_id IS DISTINCT FROM projected.parent_id
      OR artifact.hierarchy_rank IS DISTINCT FROM projected.rank
      OR artifact.canonical_child_count IS DISTINCT FROM projected.child_count
    );

  WITH scoped_artifacts AS (
    SELECT id, type, sort_order, hierarchy_rank, canonical_parent_id, created_at
    FROM artifacts
    WHERE organization_id = project_organization_uuid
      AND project_id = project_uuid
  ),
  link_candidates AS (
    SELECT
      link.id AS link_id,
      link.created_at AS link_created_at,
      link.source_id,
      link.target_id,
      link.sort_order,
      COALESCE((
        jsonb_typeof(link.metadata #> '{hierarchy,canonical}') = 'boolean'
        AND link.metadata #>> '{hierarchy,canonical}' = 'true'
      ), false) AS is_canonical,
      COALESCE((
        jsonb_typeof(link.metadata #> '{hierarchy,suppressed}') = 'boolean'
        AND link.metadata #>> '{hierarchy,suppressed}' = 'true'
      ), false) AS is_suppressed
    FROM artifact_links link
    JOIN scoped_artifacts source ON source.id = link.source_id
    JOIN scoped_artifacts target ON target.id = link.target_id
    WHERE link.organization_id = project_organization_uuid
      AND link.link_type = 'PRODUCES'::"LinkType"
  )
  SELECT
    concat(
      COALESCE(string_agg(
        artifact.id::text || ':' || artifact.type::text || ':' ||
          COALESCE(artifact.canonical_parent_id::text, 'root') || ':' ||
          COALESCE(artifact.hierarchy_rank::text, 'null') || ':' ||
          artifact.created_at::text || E'\n',
        '' ORDER BY artifact.id
      ), ''),
      E'--eligible-produces-edges--\n',
      COALESCE((
        SELECT string_agg(
          link_id::text || ':' || source_id::text || ':' ||
            target_id::text || ':' ||
            COALESCE(sort_order::text, 'null') || ':' ||
            is_canonical::text || ':' || is_suppressed::text || ':' ||
            link_created_at::text || E'\n',
          '' ORDER BY link_created_at, link_id
        )
        FROM link_candidates
      ), '')
    ),
    string_agg(
      artifact.id::text || ':' ||
        COALESCE(artifact.canonical_parent_id::text, 'root') || ':' ||
        COALESCE(artifact.hierarchy_rank::text, 'null') || E'\n',
      '' ORDER BY artifact.id
    )
  INTO hierarchy_seed, mutation_seed
  FROM scoped_artifacts artifact;

  UPDATE projects
  SET hierarchy_version = left(encode(sha256(convert_to(hierarchy_seed, 'UTF8')), 'hex'), 32),
      hierarchy_mutation_version = left(encode(sha256(convert_to(COALESCE(mutation_seed, ''), 'UTF8')), 'hex'), 32)
  WHERE id = project_uuid;
END;
$$;

-- Statement-level: a bulk write re-projects each affected project once, not
-- once per row. An UPDATE trigger with transition tables cannot name columns,
-- so the function itself skips updates that change none of the projected inputs
-- (which also ends the recursion from the projection's own UPDATE).
CREATE FUNCTION refresh_project_hierarchy_after_artifact_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_projects UUID[];
  affected_project UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT project_id ORDER BY project_id)
    INTO affected_projects
    FROM changed_rows
    WHERE project_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT project_id ORDER BY project_id)
    INTO affected_projects
    FROM previous_rows
    WHERE project_id IS NOT NULL;
  ELSE
    SELECT array_agg(DISTINCT project_id ORDER BY project_id)
    INTO affected_projects
    FROM (
      SELECT unnest(ARRAY[before.project_id, after.project_id]) AS project_id
      FROM previous_rows before
      JOIN changed_rows after ON after.id = before.id
      WHERE (before.organization_id, before.project_id, before.type,
             before.sort_order, before.created_at)
        IS DISTINCT FROM
            (after.organization_id, after.project_id, after.type,
             after.sort_order, after.created_at)
    ) moved
    WHERE project_id IS NOT NULL;
  END IF;
  FOREACH affected_project IN ARRAY COALESCE(affected_projects, ARRAY[]::uuid[])
  LOOP
    PERFORM refresh_project_hierarchy_projection(affected_project);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER artifacts_refresh_project_hierarchy_insert
AFTER INSERT ON artifacts
REFERENCING NEW TABLE AS changed_rows
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_project_hierarchy_after_artifact_change();

CREATE TRIGGER artifacts_refresh_project_hierarchy_delete
AFTER DELETE ON artifacts
REFERENCING OLD TABLE AS previous_rows
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_project_hierarchy_after_artifact_change();

CREATE TRIGGER artifacts_refresh_project_hierarchy_update
AFTER UPDATE ON artifacts
REFERENCING OLD TABLE AS previous_rows NEW TABLE AS changed_rows
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_project_hierarchy_after_artifact_change();

-- One organization-scoped admission lock serializes every PRODUCES writer,
-- including paths outside the placement API, before testing the new edge.
-- A target with no PRODUCES children cannot reach the new edge's source, so the
-- walk runs only for a target that already has descendants and a top-down bulk
-- insert never scans the organization's edges.
CREATE FUNCTION reject_produces_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.link_type <> 'PRODUCES'::"LinkType" THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(9001, hashtext(NEW.organization_id::text));

  IF NEW.source_id = NEW.target_id THEN
    RAISE EXCEPTION 'PRODUCES cycle rejected'
      USING ERRCODE = '23514', CONSTRAINT = 'artifact_links_produces_acyclic';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM artifact_links child
    WHERE child.organization_id = NEW.organization_id
      AND child.source_id = NEW.target_id
      AND child.link_type = 'PRODUCES'::"LinkType"
      AND child.id IS DISTINCT FROM NEW.id
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    -- UNION, not UNION ALL: each artifact is expanded once however many paths
    -- reach it, so a DAG of shared children costs its size, not its path count.
    WITH RECURSIVE descendants AS (
      SELECT NEW.target_id AS artifact_id
      UNION
      SELECT link.target_id
      FROM descendants
      JOIN artifact_links link ON link.source_id = descendants.artifact_id
      WHERE link.organization_id = NEW.organization_id
        AND link.link_type = 'PRODUCES'::"LinkType"
        AND link.id IS DISTINCT FROM NEW.id
    )
    SELECT 1 FROM descendants WHERE artifact_id = NEW.source_id
  ) THEN
    RAISE EXCEPTION 'PRODUCES cycle rejected'
      USING ERRCODE = '23514', CONSTRAINT = 'artifact_links_produces_acyclic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER artifact_links_reject_produces_cycle
BEFORE INSERT OR UPDATE OF source_id, target_id, link_type
ON artifact_links
FOR EACH ROW
EXECUTE FUNCTION reject_produces_cycle();

CREATE FUNCTION refresh_project_hierarchy_after_link_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  endpoint_ids UUID[];
  affected_project UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(endpoint)
    INTO endpoint_ids
    FROM changed_rows, unnest(ARRAY[source_id, target_id]) AS endpoint
    WHERE link_type = 'PRODUCES'::"LinkType";
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(endpoint)
    INTO endpoint_ids
    FROM previous_rows, unnest(ARRAY[source_id, target_id]) AS endpoint
    WHERE link_type = 'PRODUCES'::"LinkType";
  ELSE
    SELECT array_agg(endpoint)
    INTO endpoint_ids
    FROM previous_rows before
    JOIN changed_rows after ON after.id = before.id
    CROSS JOIN LATERAL unnest(ARRAY[
      CASE WHEN before.link_type = 'PRODUCES'::"LinkType" THEN before.source_id END,
      CASE WHEN before.link_type = 'PRODUCES'::"LinkType" THEN before.target_id END,
      CASE WHEN after.link_type = 'PRODUCES'::"LinkType" THEN after.source_id END,
      CASE WHEN after.link_type = 'PRODUCES'::"LinkType" THEN after.target_id END
    ]) AS endpoint
    WHERE endpoint IS NOT NULL
      AND (before.organization_id, before.source_id, before.target_id,
           before.link_type, before.sort_order, before.metadata, before.created_at)
        IS DISTINCT FROM
          (after.organization_id, after.source_id, after.target_id,
           after.link_type, after.sort_order, after.metadata, after.created_at);
  END IF;
  IF endpoint_ids IS NULL THEN
    RETURN NULL;
  END IF;
  FOR affected_project IN
    SELECT DISTINCT project_id
    FROM artifacts
    WHERE id = ANY(endpoint_ids)
      AND project_id IS NOT NULL
    ORDER BY project_id
  LOOP
    PERFORM refresh_project_hierarchy_projection(affected_project);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER artifact_links_refresh_project_hierarchy_insert
AFTER INSERT ON artifact_links
REFERENCING NEW TABLE AS changed_rows
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_project_hierarchy_after_link_change();

CREATE TRIGGER artifact_links_refresh_project_hierarchy_delete
AFTER DELETE ON artifact_links
REFERENCING OLD TABLE AS previous_rows
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_project_hierarchy_after_link_change();

CREATE TRIGGER artifact_links_refresh_project_hierarchy_update
AFTER UPDATE ON artifact_links
REFERENCING OLD TABLE AS previous_rows NEW TABLE AS changed_rows
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_project_hierarchy_after_link_change();


SELECT refresh_project_hierarchy_projection(id) FROM projects ORDER BY id;
