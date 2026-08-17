-- ISS-4778 (Part 2 of ISS-4775): remove the phantom `command` components that
-- slash-invoked SKILLS left in the cloud store, and re-point their invocations
-- and usage rollups at the real skill component.
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): this is a pure DATA
-- migration — no schema change, so `prisma migrate dev` has nothing to generate
-- and reports no drift after it is applied.
--
-- BACKGROUND: running `/cl-ci-babysit` (a SKILL) records BOTH a `<command-name>`
-- slash entry and a `Skill` tool_use, so the pre-ISS-4775 desktop materializer
-- emitted a Command candidate keyed `/cl-ci-babysit` alongside the resolved
-- Skill candidate keyed `cl-ci-babysit`. No `.claude/commands/<name>.md` exists
-- for a skill, so that command could never resolve and its label-minted
-- inventory row synced to the cloud as a phantom. ISS-4775 Part 1 (#4193)
-- stopped emitting them; this migration removes the ones already stored.
--
-- PHANTOM DEFINITION (deliberately conservative — a genuine command is never
-- touched). An `agent_components` row is a phantom only when ALL hold:
--   * component_kind = 'command'
--   * component_key  starts with '/'
--   * resolved_state <> 'resolved'
--   * content IS NULL
--   * a SIBLING row exists in the SAME (organization_id, compute_target_id) with
--     component_kind = 'skill', component_key = the command key without its
--     leading '/', and resolved_state = 'resolved'.
-- A genuine `/deploy` with no resolved `deploy` skill on the same target fails
-- the last clause and is left completely untouched.
--
-- REPAIR IDENTITY IS THE PHANTOM LINK, NOT THE KEY (review of #4247). An
-- invocation / usage row is repaired when it is LINKED to the phantom row
-- (`agent_component_id = <phantom id>`). Matching on
-- (component_kind, component_key) alone would also convert a genuine RESOLVED
-- `/review` command's rows whenever an older unresolved `/review` shadow
-- happens to share the key on that target — two `agent_components` rows can
-- carry the same `component_key` because the natural key is
-- (compute_target_id, component_kind, external_component_id). The link is
-- nullable (a row that synced before its inventory row existed carries NULL
-- until the late relink runs), so NULL-linked rows are ALSO repaired by key —
-- but only when that key is UNAMBIGUOUS on the target, i.e. no non-phantom
-- `command` component shares it. When it is ambiguous the NULL-linked row does
-- not identify which component it belongs to, so it is left alone rather than
-- guessed at.
--
-- AN AMBIGUOUS INSTALL SCOPE STAYS NULL (review of #4247). The same skill key
-- can be installed at more than one scope on one target — the
-- (compute_target_id, component_kind, external_component_id) unique key permits
-- it, and the normal resolver deliberately leaves that ambiguous. So
-- `resolved_skill.skill_id` is the skill component id ONLY when exactly one
-- resolved skill carries that key on that target; otherwise it is NULL and the
-- repaired row keeps a NULL `agent_component_id`. The kind/key identity repair
-- still happens (that part is unambiguous — `/X` was the skill `X`), we just
-- never fabricate an install this migration cannot actually determine. NULL is
-- the same degraded-but-valid state the resolver already produces, and the next
-- sync re-resolves it.
--
-- ORDERING (load-bearing): re-point the invocations, merge the usage rollups,
-- and only THEN delete the phantom inventory rows. `agent_component_invocations`
-- .agent_component_id and `agent_component_session_usage`.agent_component_id are
-- real FKs with ON DELETE SET NULL, so deleting first would sever the only link
-- back to the phantom and orphan both projections.
--
-- RETRY-IDEMPOTENT, STATEMENT BY STATEMENT (review of #4247). Prisma does not
-- wrap a migration file in a transaction the migration can rely on, and deploy
-- recovery re-runs a migration it marked rolled back — so a partially applied
-- run MUST be safe to re-apply. Every statement is driven off the phantom
-- population and the last statement removes it, so a re-run matches nothing.
-- The one statement that is not naturally re-runnable is the usage COUNT MERGE:
-- summing the phantom's counts into a survivor and then deleting the phantom in
-- a SEPARATE statement leaves a crash window in which the counts are already
-- merged but the phantom bucket still exists, and a re-run would add them a
-- second time. Step 2a therefore performs the merge and the removal in ONE
-- statement (a data-modifying CTE): either both happen or neither does, under
-- any wrapper policy. The DELETE and the UPDATE touch disjoint rows (a `command`
-- phantom bucket is never a `skill` survivor bucket), which is exactly the case
-- Postgres defines as safe for a data-modifying CTE.
--
-- FORWARD-ONLY: no rollback path. No invocation row is deleted — only usage
-- rollup rows are collapsed, and their counts are summed into the surviving skill
-- row rather than dropped.

-- ---------------------------------------------------------------------------
-- Step 1a — re-point the invocations that are LINKED to the phantom component.
-- The FK link is the definitive identity: nothing else can claim these rows.
--
-- STAGED GENERATIONS ARE EXCLUDED (`g.completed_at IS NOT NULL`). A generation
-- whose parts are still arriving is IMMUTABLE by contract: its
-- `external_generation_id` is a content hash the desktop computed over the items
-- it sent, and `completeGenerationIfReady` re-derives that hash from the stored
-- invocation rows once the last part lands. Rewriting a staged row's
-- kind/key/normalized_name here would make that re-derivation diverge, so the
-- generation would be rejected with `GenerationConflict` forever — the part
-- ledger is already recorded, so no retry can ever replace it, and the session
-- would permanently lose that generation. Staged rows are therefore left alone;
-- they resolve normally on completion (their now-deleted phantom inventory row
-- simply leaves `agent_component_id` NULL, which is the same degraded-but-valid
-- state a version-skewed client already produces) and self-heal on the next sync
-- from an ISS-4775-fixed desktop.
-- ---------------------------------------------------------------------------
WITH resolved_skill AS (
    SELECT organization_id,
           compute_target_id,
           component_key,
           CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END AS skill_id
    FROM agent_components
    WHERE component_kind = 'skill'
      AND resolved_state = 'resolved'
      AND component_key IS NOT NULL
    GROUP BY organization_id, compute_target_id, component_key
),
phantom AS (
    SELECT p.id              AS phantom_id,
           p.organization_id,
           p.compute_target_id,
           p.component_key   AS phantom_key,
           s.component_key   AS skill_key,
           s.skill_id
    FROM agent_components p
    JOIN resolved_skill s
      ON s.organization_id = p.organization_id
     AND s.compute_target_id = p.compute_target_id
     AND s.component_key = substring(p.component_key FROM 2)
    WHERE p.component_kind = 'command'
      AND p.component_key LIKE '/%'
      AND p.resolved_state <> 'resolved'
      AND p.content IS NULL
)
UPDATE agent_component_invocations aci
   SET agent_component_id = m.skill_id,
       component_kind     = 'skill',
       component_key      = m.skill_key,
       normalized_name    = CASE
         WHEN aci.normalized_name = m.phantom_key THEN m.skill_key
         ELSE aci.normalized_name
       END,
       updated_at = NOW()
  FROM agent_component_invocation_generations g, phantom m
 WHERE aci.generation_id = g.id
   AND g.completed_at IS NOT NULL
   AND aci.component_kind = 'command'
   AND aci.agent_component_id = m.phantom_id;

-- ---------------------------------------------------------------------------
-- Step 1b — re-point the invocations that carry NO inventory link yet, keyed by
-- `component_key` and scoped through the owning generation -> session_detail so
-- a device's phantom can only ever repair invocations captured on THAT device.
-- Skipped entirely for a key that is ambiguous on the target (see the header):
-- an unlinked row cannot prove it belongs to the phantom rather than to a
-- genuine same-key command, and a wrong conversion is unrecoverable.
-- ---------------------------------------------------------------------------
WITH resolved_skill AS (
    SELECT organization_id,
           compute_target_id,
           component_key,
           CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END AS skill_id
    FROM agent_components
    WHERE component_kind = 'skill'
      AND resolved_state = 'resolved'
      AND component_key IS NOT NULL
    GROUP BY organization_id, compute_target_id, component_key
),
phantom AS (
    SELECT p.id              AS phantom_id,
           p.organization_id,
           p.compute_target_id,
           p.component_key   AS phantom_key,
           s.component_key   AS skill_key,
           s.skill_id
    FROM agent_components p
    JOIN resolved_skill s
      ON s.organization_id = p.organization_id
     AND s.compute_target_id = p.compute_target_id
     AND s.component_key = substring(p.component_key FROM 2)
    WHERE p.component_kind = 'command'
      AND p.component_key LIKE '/%'
      AND p.resolved_state <> 'resolved'
      AND p.content IS NULL
),
unambiguous_phantom AS (
    SELECT DISTINCT
           p.compute_target_id,
           p.phantom_key,
           p.skill_key,
           p.skill_id
    FROM phantom p
    WHERE NOT EXISTS (
      SELECT 1
        FROM agent_components other
       WHERE other.component_kind = 'command'
         AND other.organization_id = p.organization_id
         AND other.compute_target_id = p.compute_target_id
         AND other.component_key = p.phantom_key
         AND NOT EXISTS (
           SELECT 1 FROM phantom ph WHERE ph.phantom_id = other.id
         )
    )
)
UPDATE agent_component_invocations aci
   SET agent_component_id = m.skill_id,
       component_kind     = 'skill',
       component_key      = m.skill_key,
       normalized_name    = CASE
         WHEN aci.normalized_name = m.phantom_key THEN m.skill_key
         ELSE aci.normalized_name
       END,
       updated_at = NOW()
  FROM agent_component_invocation_generations g
  JOIN session_detail sd ON sd.artifact_id = g.agent_session_id
  JOIN unambiguous_phantom m ON m.compute_target_id = sd.compute_target_id
 WHERE aci.generation_id = g.id
   AND g.completed_at IS NOT NULL
   AND aci.component_kind = 'command'
   AND aci.agent_component_id IS NULL
   AND aci.component_key = m.phantom_key;

-- ---------------------------------------------------------------------------
-- Step 2a — MERGE the phantom usage rollup into an already-existing skill
-- rollup row for the same (session, branch), AND remove the merged-away phantom
-- bucket, in ONE atomic statement. `agent_component_session_usage` is unique on
-- (agent_session_id, component_kind, component_key, git_branch), so blindly
-- re-pointing the key would raise a unique violation whenever the session ALSO
-- recorded the real skill — which, for a slash-invoked skill, is always.
--
-- The single-statement form is what makes a re-run safe: a two-statement
-- "sum then delete" leaves a window where the counts are merged but the phantom
-- bucket survives, and re-running the migration would sum them in again (see
-- the RETRY-IDEMPOTENT note in the header).
--
-- `agent_component_id` is repaired on the survivor too: a pre-existing skill
-- bucket can legitimately carry NULL there (usage can be recorded before the
-- inventory row exists), and deleting the phantom bucket would otherwise throw
-- away the only link this session had. COALESCE keeps an existing link and only
-- fills a NULL — and `skill_id` is itself NULL when the install scope is
-- ambiguous, so nothing is ever fabricated.
--
-- At most one phantom bucket can target a given survivor: phantom keys are
-- unique per (session, branch) and `/X` -> `X` is injective, so no aggregation
-- is needed.
-- ---------------------------------------------------------------------------
WITH resolved_skill AS (
    SELECT organization_id,
           compute_target_id,
           component_key,
           CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END AS skill_id
    FROM agent_components
    WHERE component_kind = 'skill'
      AND resolved_state = 'resolved'
      AND component_key IS NOT NULL
    GROUP BY organization_id, compute_target_id, component_key
),
phantom AS (
    SELECT p.id              AS phantom_id,
           p.organization_id,
           p.compute_target_id,
           p.component_key   AS phantom_key,
           s.component_key   AS skill_key,
           s.skill_id
    FROM agent_components p
    JOIN resolved_skill s
      ON s.organization_id = p.organization_id
     AND s.compute_target_id = p.compute_target_id
     AND s.component_key = substring(p.component_key FROM 2)
    WHERE p.component_kind = 'command'
      AND p.component_key LIKE '/%'
      AND p.resolved_state <> 'resolved'
      AND p.content IS NULL
),
phantom_usage AS (
    SELECT DISTINCT ON (u.id)
           u.id AS usage_id,
           u.agent_session_id,
           u.git_branch,
           m.skill_key,
           m.skill_id
    FROM agent_component_session_usage u
    JOIN session_detail sd ON sd.artifact_id = u.agent_session_id
    JOIN phantom m ON m.compute_target_id = sd.compute_target_id
    WHERE u.component_kind = 'command'
      AND (
        u.agent_component_id = m.phantom_id
        OR (
          u.agent_component_id IS NULL
          AND u.component_key = m.phantom_key
          AND NOT EXISTS (
            SELECT 1
              FROM agent_components other
             WHERE other.component_kind = 'command'
               AND other.organization_id = m.organization_id
               AND other.compute_target_id = m.compute_target_id
               AND other.component_key = m.phantom_key
               AND NOT EXISTS (
                 SELECT 1 FROM phantom ph WHERE ph.phantom_id = other.id
               )
          )
        )
      )
    ORDER BY u.id, m.phantom_id
),
merged AS (
    DELETE FROM agent_component_session_usage victim
     USING phantom_usage p
     WHERE victim.id = p.usage_id
       AND EXISTS (
         SELECT 1
           FROM agent_component_session_usage survivor
          WHERE survivor.agent_session_id = p.agent_session_id
            AND survivor.component_kind = 'skill'
            AND survivor.component_key = p.skill_key
            AND survivor.git_branch = p.git_branch
       )
    RETURNING p.agent_session_id,
              p.skill_key,
              p.skill_id,
              p.git_branch,
              victim.invocation_count,
              victim.error_count,
              victim.first_invoked_at,
              victim.last_invoked_at
)
UPDATE agent_component_session_usage survivor
   SET invocation_count   = survivor.invocation_count + m.invocation_count,
       error_count        = survivor.error_count + m.error_count,
       first_invoked_at   = LEAST(survivor.first_invoked_at, m.first_invoked_at),
       last_invoked_at    = GREATEST(survivor.last_invoked_at, m.last_invoked_at),
       agent_component_id = COALESCE(survivor.agent_component_id, m.skill_id),
       updated_at         = NOW()
  FROM merged m
 WHERE survivor.agent_session_id = m.agent_session_id
   AND survivor.component_kind = 'skill'
   AND survivor.component_key = m.skill_key
   AND survivor.git_branch = m.git_branch;

-- ---------------------------------------------------------------------------
-- Step 2b — re-point the phantom usage rows that had no colliding skill row.
-- Step 2a already removed every colliding one, so whatever the same predicate
-- still selects is collision-free and can simply take the skill identity.
-- ---------------------------------------------------------------------------
WITH resolved_skill AS (
    SELECT organization_id,
           compute_target_id,
           component_key,
           CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END AS skill_id
    FROM agent_components
    WHERE component_kind = 'skill'
      AND resolved_state = 'resolved'
      AND component_key IS NOT NULL
    GROUP BY organization_id, compute_target_id, component_key
),
phantom AS (
    SELECT p.id              AS phantom_id,
           p.organization_id,
           p.compute_target_id,
           p.component_key   AS phantom_key,
           s.component_key   AS skill_key,
           s.skill_id
    FROM agent_components p
    JOIN resolved_skill s
      ON s.organization_id = p.organization_id
     AND s.compute_target_id = p.compute_target_id
     AND s.component_key = substring(p.component_key FROM 2)
    WHERE p.component_kind = 'command'
      AND p.component_key LIKE '/%'
      AND p.resolved_state <> 'resolved'
      AND p.content IS NULL
),
phantom_usage AS (
    SELECT DISTINCT ON (u.id)
           u.id AS usage_id,
           m.skill_key,
           m.skill_id
    FROM agent_component_session_usage u
    JOIN session_detail sd ON sd.artifact_id = u.agent_session_id
    JOIN phantom m ON m.compute_target_id = sd.compute_target_id
    WHERE u.component_kind = 'command'
      AND (
        u.agent_component_id = m.phantom_id
        OR (
          u.agent_component_id IS NULL
          AND u.component_key = m.phantom_key
          AND NOT EXISTS (
            SELECT 1
              FROM agent_components other
             WHERE other.component_kind = 'command'
               AND other.organization_id = m.organization_id
               AND other.compute_target_id = m.compute_target_id
               AND other.component_key = m.phantom_key
               AND NOT EXISTS (
                 SELECT 1 FROM phantom ph WHERE ph.phantom_id = other.id
               )
          )
        )
      )
    ORDER BY u.id, m.phantom_id
)
UPDATE agent_component_session_usage u
   SET component_kind     = 'skill',
       component_key      = p.skill_key,
       agent_component_id = p.skill_id,
       updated_at         = NOW()
  FROM phantom_usage p
 WHERE u.id = p.usage_id;

-- ---------------------------------------------------------------------------
-- Step 3a — drop the unified-search projection rows for the phantoms about to be
-- deleted. `search_document` is a denormalized mirror with no FK back to the
-- source row (see the model comment), so nothing would clean these up otherwise
-- and the component detail route would keep surfacing a dead hit.
-- ---------------------------------------------------------------------------
WITH resolved_skill AS (
    SELECT organization_id, compute_target_id, component_key
    FROM agent_components
    WHERE component_kind = 'skill'
      AND resolved_state = 'resolved'
      AND component_key IS NOT NULL
    GROUP BY organization_id, compute_target_id, component_key
),
phantom AS (
    SELECT p.id
    FROM agent_components p
    JOIN resolved_skill s
      ON s.organization_id = p.organization_id
     AND s.compute_target_id = p.compute_target_id
     AND s.component_key = substring(p.component_key FROM 2)
    WHERE p.component_kind = 'command'
      AND p.component_key LIKE '/%'
      AND p.resolved_state <> 'resolved'
      AND p.content IS NULL
)
DELETE FROM search_document sd
 USING phantom p
 WHERE sd.entity_type = 'agent_component'
   AND sd.entity_id = p.id;

-- ---------------------------------------------------------------------------
-- Step 3b — delete the phantom inventory rows LAST. There are no
-- `agent_component_versions` / `definition_versions` rows to clean up: a phantom
-- by definition never captured content, and both of those identities require a
-- content hash.
-- ---------------------------------------------------------------------------
WITH resolved_skill AS (
    SELECT organization_id, compute_target_id, component_key
    FROM agent_components
    WHERE component_kind = 'skill'
      AND resolved_state = 'resolved'
      AND component_key IS NOT NULL
    GROUP BY organization_id, compute_target_id, component_key
),
phantom AS (
    SELECT p.id
    FROM agent_components p
    JOIN resolved_skill s
      ON s.organization_id = p.organization_id
     AND s.compute_target_id = p.compute_target_id
     AND s.component_key = substring(p.component_key FROM 2)
    WHERE p.component_kind = 'command'
      AND p.component_key LIKE '/%'
      AND p.resolved_state <> 'resolved'
      AND p.content IS NULL
)
DELETE FROM agent_components c
 USING phantom p
 WHERE c.id = p.id;
