-- ISS-4778 (Part 2 of ISS-4775): remove the phantom `command` components that
-- slash-invoked SKILLS left behind in the local store, and re-point their
-- invocations at the real skill component.
--
-- BACKGROUND: running `/cl-ci-babysit` (a SKILL) records BOTH a `<command-name>`
-- slash entry and a `Skill` tool_use, so the pre-ISS-4775 materializer emitted a
-- Command candidate keyed `/cl-ci-babysit` alongside the resolved Skill
-- candidate keyed `cl-ci-babysit`. No `.claude/commands/<name>.md` exists for a
-- skill (its entrypoint is `SKILL.md`), so that Command candidate could never
-- resolve and its label-minted `agent_components` row lingers as a phantom.
-- ISS-4775 Part 1 (#4193) stopped EMITTING them; this migration removes the ones
-- already on disk.
--
-- PHANTOM DEFINITION (deliberately conservative — a genuine command is never
-- touched). An `agent_components` row is a phantom only when ALL hold:
--   * component_kind = 'command'
--   * component_key  starts with '/'
--   * resolved_state is not 'resolved'  (label-minted rows carry 'unresolved')
--   * content IS NULL                   (no definition text was ever captured)
--   * a SIBLING row exists with component_kind = 'skill',
--     component_key = the command key without its leading '/', and
--     resolved_state = 'resolved'.
-- A genuine `/deploy` with no resolved `deploy` skill fails the last clause and
-- is left completely untouched, even though it is also unresolved.
--
-- The local store is DEVICE-scoped (no org / compute-target columns on
-- `agent_components`), so "same scope" is the whole store.
--
-- ORDERING (load-bearing): mark the affected sessions FIRST, re-point the
-- invocations SECOND, delete the phantom components LAST. Deleting first would
-- null out `local_component_id` (FK ON DELETE SET NULL) and lose the only link
-- back to the phantom, and the session set can no longer be derived once the
-- invocations have been re-pointed.
--
-- IDEMPOTENT: every statement is driven off the phantom-component predicate, and
-- the last statement removes that population, so a second run matches nothing.
--
-- FORWARD-ONLY: no rollback path. The invocation rows are never deleted, so no
-- occurrence evidence is lost.

-- ---------------------------------------------------------------------------
-- Step 1 — mark every session that owns a phantom invocation as stale, so the
-- boot rebuild (`data-revision-rebuild.ts`, which selects
-- `data_revision != DATA_REVISION`) re-derives it and re-materializes
-- `agent_component_session_usage` through the tested rollup
-- (`rebuildAgentComponentSessionUsageFromInvocations`) rather than any
-- hand-written rollup SQL here. `0` can never collide with a real revision
-- (the column DEFAULT is 1 and DATA_REVISION only increases).
-- ---------------------------------------------------------------------------
UPDATE sessions
   SET data_revision = 0
 WHERE id IN (
   SELECT i.session_id
     FROM agent_component_invocations i
    WHERE i.component_kind = 'command'
      AND i.component_key LIKE '/%'
      AND EXISTS (
        SELECT 1
          FROM agent_components c
         WHERE c.component_kind = 'command'
           AND c.component_key = i.component_key
           AND (c.resolved_state IS NULL OR c.resolved_state <> 'resolved')
           AND c.content IS NULL
           AND EXISTS (
             SELECT 1
               FROM agent_components s
              WHERE s.component_kind = 'skill'
                AND s.component_key = substr(c.component_key, 2)
                AND s.resolved_state = 'resolved'
           )
      )
 );

-- ---------------------------------------------------------------------------
-- Step 2 — re-point the phantom's invocations onto the skill identity. No row is
-- deleted: an invocation is the durable per-firing evidence (transcript anchor +
-- evidence pointer), and the user really did fire the skill by typing `/X`.
--
-- SQLite evaluates every SET expression against the ORIGINAL row, so
-- `substr(component_key, 2)` and the `normalized_name` CASE both read the
-- pre-update `/X` value.
--
-- `normalized_name` is the normalized identity, so it follows the key; `raw_name`
-- is the verbatim transcript text and is deliberately preserved.
--
-- `ORDER BY s.id LIMIT 1` makes the skill choice deterministic when the same
-- skill key is installed at more than one scope (user + project), which the
-- (component_kind, external_id) unique index permits.
-- ---------------------------------------------------------------------------
UPDATE agent_component_invocations
   SET component_kind = 'skill',
       component_key = substr(component_key, 2),
       normalized_name = CASE
         WHEN normalized_name = component_key THEN substr(component_key, 2)
         ELSE normalized_name
       END,
       local_component_id = (
         SELECT s.id
           FROM agent_components s
          WHERE s.component_kind = 'skill'
            AND s.component_key = substr(agent_component_invocations.component_key, 2)
            AND s.resolved_state = 'resolved'
          ORDER BY s.id
          LIMIT 1
       )
 WHERE component_kind = 'command'
   AND component_key LIKE '/%'
   AND EXISTS (
     SELECT 1
       FROM agent_components c
      WHERE c.component_kind = 'command'
        AND c.component_key = agent_component_invocations.component_key
        AND (c.resolved_state IS NULL OR c.resolved_state <> 'resolved')
        AND c.content IS NULL
        AND EXISTS (
          SELECT 1
            FROM agent_components s
           WHERE s.component_kind = 'skill'
             AND s.component_key = substr(c.component_key, 2)
             AND s.resolved_state = 'resolved'
        )
   );

-- ---------------------------------------------------------------------------
-- Step 3 — delete the phantom inventory rows LAST. There are no
-- `agent_component_versions` rows to clean up: a phantom by definition never
-- captured content, and a version row's identity requires a content hash.
-- ---------------------------------------------------------------------------
DELETE FROM agent_components
 WHERE component_kind = 'command'
   AND component_key LIKE '/%'
   AND (resolved_state IS NULL OR resolved_state <> 'resolved')
   AND content IS NULL
   AND EXISTS (
     SELECT 1
       FROM agent_components s
      WHERE s.component_kind = 'skill'
        AND s.component_key = substr(agent_components.component_key, 2)
        AND s.resolved_state = 'resolved'
   );
