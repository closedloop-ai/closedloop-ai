/**
 * ISS-4778 (Part 2 of ISS-4775) — behavioural coverage for the cloud data
 * migration `20260802180000_iss4778_backfill_phantom_command_components`.
 *
 * Runs the committed migration SQL verbatim against a REAL Postgres (the same
 * migrated database the CI `test` job provisions), inside a transaction that is
 * always rolled back, so the suite seeds its own fixture and leaves nothing
 * behind. Only a real database can prove the two things that matter here: that
 * the usage merge does not trip the
 * `(agent_session_id, component_kind, component_key, git_branch)` unique index,
 * and that the FK-bearing re-point happens before the phantom is deleted.
 *
 * Skips when DATABASE_URL is unset (local runs without `docker compose up -d`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "prisma",
    "migrations",
    "20260802180000_iss4778_backfill_phantom_command_components",
    "migration.sql"
  ),
  "utf8"
);

const DATABASE_URL = process.env.DATABASE_URL;

const ORG_ID = "019f0000-0000-7000-8000-000000000001";
const USER_ID = "019f0000-0000-7000-8000-000000000002";
const TARGET_ID = "019f0000-0000-7000-8000-000000000003";
const OTHER_TARGET_ID = "019f0000-0000-7000-8000-000000000004";
const SESSION_ID = "019f0000-0000-7000-8000-000000000005";
const GENERATION_ID = "019f0000-0000-7000-8000-000000000006";
const PART_ID = "019f0000-0000-7000-8000-000000000007";
const STAGED_GENERATION_ID = "019f0000-0000-7000-8000-000000000008";
const STAGED_PART_ID = "019f0000-0000-7000-8000-000000000009";
const SKILL_COMPONENT_ID = "019f0000-0000-7000-8000-000000000010";
const PHANTOM_COMPONENT_ID = "019f0000-0000-7000-8000-000000000011";
const GENUINE_COMPONENT_ID = "019f0000-0000-7000-8000-000000000012";
const OTHER_TARGET_COMMAND_ID = "019f0000-0000-7000-8000-000000000013";
const SKILL_INVOCATION_ID = "019f0000-0000-7000-8000-000000000020";
const PHANTOM_INVOCATION_ID = "019f0000-0000-7000-8000-000000000021";
const GENUINE_INVOCATION_ID = "019f0000-0000-7000-8000-000000000022";
const STAGED_PHANTOM_INVOCATION_ID = "019f0000-0000-7000-8000-000000000023";
const SKILL_USAGE_ID = "019f0000-0000-7000-8000-000000000030";
const PHANTOM_USAGE_COLLIDING_ID = "019f0000-0000-7000-8000-000000000031";
const PHANTOM_USAGE_UNIQUE_BRANCH_ID = "019f0000-0000-7000-8000-000000000032";
const GENUINE_USAGE_ID = "019f0000-0000-7000-8000-000000000033";
const SEARCH_PHANTOM_ID = "019f0000-0000-7000-8000-000000000040";
const SEARCH_GENUINE_ID = "019f0000-0000-7000-8000-000000000041";

const SECOND_SKILL_COMPONENT_ID = "019f0000-0000-7000-8000-000000000050";
const RESOLVED_COMMAND_ID = "019f0000-0000-7000-8000-000000000051";
const UNLINKED_INVOCATION_ID = "019f0000-0000-7000-8000-000000000052";
const UNLINKED_USAGE_ID = "019f0000-0000-7000-8000-000000000053";

const SKILL_KEY = "review";
const PHANTOM_KEY = "/review";
const GENUINE_KEY = "/deploy";
const BRANCH_MAIN = "";
const BRANCH_FEATURE = "feat/x";
const BRANCH_OTHER = "feat/y";
const AT = "2026-08-01T12:00:00.000Z";

/**
 * The migration's statements, in file order, with `--` comment lines stripped.
 * Used to prove RETRY-IDEMPOTENCY after a PARTIAL application: apply a prefix,
 * then apply the whole file again and assert the result matches a single clean
 * run. Comments are removed first because prose contains `;`; no string literal
 * or body in `migration.sql` does, so splitting the remainder on the statement
 * terminator is exact.
 */
const MIGRATION_STATEMENTS = MIGRATION_SQL.split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0)
  .map((statement) => `${statement};`);

describe.skipIf(!DATABASE_URL)(
  "ISS-4778 cloud phantom-command backfill migration",
  () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
    });

    afterAll(async () => {
      await client.end();
    });

    beforeEach(async () => {
      await client.query("BEGIN");
      await seedFixture(client);
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it("re-points the phantom's invocations onto the resolved skill component", async () => {
      await client.query(MIGRATION_SQL);

      const invocations = await readInvocations(client);
      expect(invocations).toEqual([
        {
          agent_component_id: SKILL_COMPONENT_ID,
          component_key: SKILL_KEY,
          component_kind: AgentComponentKind.Skill,
          id: SKILL_INVOCATION_ID,
          normalized_name: SKILL_KEY,
        },
        {
          agent_component_id: SKILL_COMPONENT_ID,
          component_key: SKILL_KEY,
          component_kind: AgentComponentKind.Skill,
          id: PHANTOM_INVOCATION_ID,
          normalized_name: SKILL_KEY,
        },
        {
          agent_component_id: GENUINE_COMPONENT_ID,
          component_key: GENUINE_KEY,
          component_kind: AgentComponentKind.Command,
          id: GENUINE_INVOCATION_ID,
          normalized_name: GENUINE_KEY,
        },
      ]);
    });

    it("leaves a still-staged generation's hashed identity fields untouched", async () => {
      const before = await readStagedInvocationIdentities(client);

      await client.query(MIGRATION_SQL);

      // Every field in `INVOCATION_HASH_SELECT` that the migration could rewrite
      // must be untouched — a rewrite here makes `completeGenerationIfReady`
      // re-derive a different `external_generation_id` and reject the generation
      // with `GenerationConflict` on every subsequent part, permanently.
      expect(await readStagedInvocationIdentities(client)).toEqual(before);
      expect(before).toEqual([
        {
          component_key: PHANTOM_KEY,
          component_kind: AgentComponentKind.Command,
          id: STAGED_PHANTOM_INVOCATION_ID,
          normalized_name: PHANTOM_KEY,
        },
      ]);
    });

    it("nulls the staged row's inventory FK without touching its hashed identity", async () => {
      await client.query(MIGRATION_SQL);

      // `agent_component_id` is NOT part of the generation hash preimage, so the
      // `ON DELETE SET NULL` from step 3b is safe: the staged generation still
      // completes, and its re-resolution on completion re-derives the FK.
      const result = await client.query<{ agent_component_id: string | null }>(
        "SELECT agent_component_id FROM agent_component_invocations WHERE id = $1",
        [STAGED_PHANTOM_INVOCATION_ID]
      );
      expect(result.rows).toEqual([{ agent_component_id: null }]);
    });

    it("merges colliding usage by summing counts and re-points the rest, with no unique violation", async () => {
      await client.query(MIGRATION_SQL);

      const usage = await readUsage(client);
      expect(usage).toEqual([
        {
          agent_component_id: GENUINE_COMPONENT_ID,
          component_key: GENUINE_KEY,
          component_kind: AgentComponentKind.Command,
          error_count: 0,
          git_branch: BRANCH_MAIN,
          invocation_count: 7,
        },
        {
          agent_component_id: SKILL_COMPONENT_ID,
          component_key: SKILL_KEY,
          component_kind: AgentComponentKind.Skill,
          error_count: 3,
          git_branch: BRANCH_MAIN,
          invocation_count: 5,
        },
        {
          agent_component_id: SKILL_COMPONENT_ID,
          component_key: SKILL_KEY,
          component_kind: AgentComponentKind.Skill,
          error_count: 0,
          git_branch: BRANCH_FEATURE,
          invocation_count: 4,
        },
      ]);
    });

    it("deletes the phantom component and its search projection, preserving a genuine command", async () => {
      await client.query(MIGRATION_SQL);

      expect(await readComponentIds(client)).toEqual([
        GENUINE_COMPONENT_ID,
        OTHER_TARGET_COMMAND_ID,
        SKILL_COMPONENT_ID,
      ]);
      expect(await readSearchEntityIds(client)).toEqual([GENUINE_COMPONENT_ID]);
    });

    it("leaves a same-named command on another compute target untouched", async () => {
      await client.query(MIGRATION_SQL);

      const row = await client.query<{
        component_key: string;
        component_kind: string;
      }>(
        "SELECT component_kind, component_key FROM agent_components WHERE id = $1",
        [OTHER_TARGET_COMMAND_ID]
      );
      expect(row.rows).toEqual([
        {
          component_key: PHANTOM_KEY,
          component_kind: AgentComponentKind.Command,
        },
      ]);
    });

    it("is idempotent — a second application changes nothing", async () => {
      await client.query(MIGRATION_SQL);
      const firstUsage = await readUsage(client);
      const firstComponents = await readComponentIds(client);

      await client.query(MIGRATION_SQL);

      expect(await readUsage(client)).toEqual(firstUsage);
      expect(await readComponentIds(client)).toEqual(firstComponents);
    });

    // wongk (PR #4247): the count merge must survive a re-run after a PARTIAL
    // application. Deploy recovery marks a failed migration rolled back and
    // re-runs it, so summing the phantom's counts into the survivor in one
    // statement and deleting the phantom bucket in the NEXT one would add the
    // counts a second time. Apply everything through the merge, then apply the
    // whole file again, and the result must match a single clean run.
    it("does not double-count when re-applied after a partial run", async () => {
      const throughMerge = MIGRATION_STATEMENTS.slice(
        0,
        mergeStatementIndex() + 1
      ).join("\n");

      await client.query(throughMerge);
      await client.query(MIGRATION_SQL);

      expect(await readUsage(client)).toEqual([
        {
          agent_component_id: GENUINE_COMPONENT_ID,
          component_key: GENUINE_KEY,
          component_kind: AgentComponentKind.Command,
          error_count: 0,
          git_branch: BRANCH_MAIN,
          invocation_count: 7,
        },
        {
          agent_component_id: SKILL_COMPONENT_ID,
          component_key: SKILL_KEY,
          component_kind: AgentComponentKind.Skill,
          error_count: 3,
          git_branch: BRANCH_MAIN,
          invocation_count: 5,
        },
        {
          agent_component_id: SKILL_COMPONENT_ID,
          component_key: SKILL_KEY,
          component_kind: AgentComponentKind.Skill,
          error_count: 0,
          git_branch: BRANCH_FEATURE,
          invocation_count: 4,
        },
      ]);
    });

    // wongk (PR #4247): a pre-existing skill bucket can legitimately carry a
    // NULL `agent_component_id` (usage can be recorded before the inventory row
    // syncs). Deleting the phantom bucket would otherwise throw away the only
    // inventory link this session/branch had.
    it("fills a NULL agent_component_id on the surviving skill usage bucket", async () => {
      await client.query(
        "UPDATE agent_component_session_usage SET agent_component_id = NULL WHERE id = $1",
        [SKILL_USAGE_ID]
      );

      await client.query(MIGRATION_SQL);

      const result = await client.query<{ agent_component_id: string | null }>(
        "SELECT agent_component_id FROM agent_component_session_usage WHERE id = $1",
        [SKILL_USAGE_ID]
      );
      expect(result.rows).toEqual([{ agent_component_id: SKILL_COMPONENT_ID }]);
    });

    // wongk (PR #4247): picking the lowest component UUID does not resolve the
    // install scope. When the same skill key is installed at more than one scope
    // on one target the row does not identify WHICH install ran, so the repaired
    // rows must keep a NULL link rather than be permanently attributed to one.
    it("keeps the inventory link NULL when the skill key is installed twice", async () => {
      await seedSecondResolvedSkill(client);

      await client.query(MIGRATION_SQL);

      const invocation = await client.query<{
        agent_component_id: string | null;
        component_key: string;
        component_kind: string;
      }>(
        `SELECT component_kind, component_key, agent_component_id
           FROM agent_component_invocations WHERE id = $1`,
        [PHANTOM_INVOCATION_ID]
      );
      // The kind/key identity repair is unambiguous and still happens; only the
      // install attribution is withheld.
      expect(invocation.rows).toEqual([
        {
          agent_component_id: null,
          component_key: SKILL_KEY,
          component_kind: AgentComponentKind.Skill,
        },
      ]);
      const usage = await client.query<{ agent_component_id: string | null }>(
        `SELECT agent_component_id FROM agent_component_session_usage
          WHERE agent_session_id = $1 AND component_kind = $2
            AND component_key = $3 AND git_branch = $4`,
        [SESSION_ID, AgentComponentKind.Skill, SKILL_KEY, BRANCH_FEATURE]
      );
      expect(usage.rows).toEqual([{ agent_component_id: null }]);
    });

    // wongk (PR #4247): matching by (kind, key) rather than by the phantom link
    // converts a genuine RESOLVED `/review` command's rows too, whenever it
    // shares the key with an older unresolved shadow on the same target. An
    // unlinked row cannot prove which of the two it belongs to, so it is left.
    it("leaves an unlinked row alone when a genuine command shares the key", async () => {
      await seedResolvedSameKeyCommand(client);
      await seedUnlinkedPhantomKeyedRows(client);

      await client.query(MIGRATION_SQL);

      expect(
        await readInvocationIdentity(client, UNLINKED_INVOCATION_ID)
      ).toEqual({
        agent_component_id: null,
        component_key: PHANTOM_KEY,
        component_kind: AgentComponentKind.Command,
      });
      const usage = await client.query<{
        component_key: string;
        component_kind: string;
      }>(
        "SELECT component_kind, component_key FROM agent_component_session_usage WHERE id = $1",
        [UNLINKED_USAGE_ID]
      );
      expect(usage.rows).toEqual([
        {
          component_key: PHANTOM_KEY,
          component_kind: AgentComponentKind.Command,
        },
      ]);
      // The genuine command survives with its own rows intact…
      expect(await readComponentIds(client)).toContain(RESOLVED_COMMAND_ID);
    });

    // …and the same unlinked row IS repaired when nothing else claims the key,
    // which is the migration-window case step 1b exists for (an invocation that
    // synced before its inventory row did carries a NULL link).
    it("repairs an unlinked row when the key is unambiguous on the target", async () => {
      await seedUnlinkedPhantomKeyedRows(client);

      await client.query(MIGRATION_SQL);

      expect(
        await readInvocationIdentity(client, UNLINKED_INVOCATION_ID)
      ).toEqual({
        agent_component_id: SKILL_COMPONENT_ID,
        component_key: SKILL_KEY,
        component_kind: AgentComponentKind.Skill,
      });
    });
  }
);

/** The single statement that merges the phantom's counts and drops its bucket. */
function mergeStatementIndex(): number {
  const index = MIGRATION_STATEMENTS.findIndex((statement) =>
    statement.includes("merged AS (")
  );
  if (index < 0) {
    throw new Error("no atomic merge statement found in the migration");
  }
  return index;
}

async function seedFixture(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO organizations (id, clerk_id, name, slug, updated_at)
     VALUES ($1, $2, 'ISS-4778 Fixture', $2, $3)`,
    [ORG_ID, `iss4778-${ORG_ID}`, AT]
  );
  await client.query(
    `INSERT INTO users (id, clerk_id, organization_id, email, updated_at)
     VALUES ($1, $2, $3, 'iss4778@example.test', $4)`,
    [USER_ID, `iss4778-${USER_ID}`, ORG_ID, AT]
  );
  await client.query(
    `INSERT INTO compute_targets (id, organization_id, user_id, machine_name, platform, updated_at)
     VALUES ($1, $3, $4, 'fixture-a', 'darwin', $5),
            ($2, $3, $4, 'fixture-b', 'darwin', $5)`,
    [TARGET_ID, OTHER_TARGET_ID, ORG_ID, USER_ID, AT]
  );
  await client.query(
    `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
     VALUES ($1, $2, 'SESSION', 'ISS-4778 session', 'ACTIVE', $3)`,
    [SESSION_ID, ORG_ID, AT]
  );
  await client.query(
    `INSERT INTO session_detail (
       artifact_id, compute_target_id, external_session_id,
       session_started_at, session_updated_at, updated_at
     ) VALUES ($1, $2, 'external-iss4778', $3, $3, $3)`,
    [SESSION_ID, TARGET_ID, AT]
  );
  await seedComponents(client);
  await seedInvocations(client);
  await seedUsage(client);
  await seedSearchDocuments(client);
}

async function seedComponents(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO agent_components (
       id, organization_id, compute_target_id, component_kind,
       external_component_id, component_key, resolved_state, content, updated_at
     ) VALUES
       ($1, $5, $6, 'skill',   'skill:review', $9,  'resolved',   '# Review', $8),
       ($2, $5, $6, 'command', '/review',      $10, 'unresolved', NULL,       $8),
       ($3, $5, $6, 'command', '/deploy',      $11, 'unresolved', NULL,       $8),
       ($4, $5, $7, 'command', '/review',      $10, 'unresolved', NULL,       $8)`,
    [
      SKILL_COMPONENT_ID,
      PHANTOM_COMPONENT_ID,
      GENUINE_COMPONENT_ID,
      OTHER_TARGET_COMMAND_ID,
      ORG_ID,
      TARGET_ID,
      OTHER_TARGET_ID,
      AT,
      SKILL_KEY,
      PHANTOM_KEY,
      GENUINE_KEY,
    ]
  );
}

async function seedInvocations(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO agent_component_invocation_generations (
       id, agent_session_id, external_generation_id, source_updated_at,
       data_revision, source_sequence, expected_part_count, active_at,
       completed_at, updated_at
     ) VALUES ($1, $2, 'generation-1', $3, 63, 1, 1, $3, $3, $3)`,
    [GENERATION_ID, SESSION_ID, AT]
  );
  // A SECOND generation for the same session whose parts are still arriving
  // (`active_at`/`completed_at` NULL). Its staged rows feed the content hash
  // `completeGenerationIfReady` re-derives, so the migration must not touch them.
  await client.query(
    `INSERT INTO agent_component_invocation_generations (
       id, agent_session_id, external_generation_id, source_updated_at,
       data_revision, source_sequence, expected_part_count, updated_at
     ) VALUES ($1, $2, 'generation-2', $3, 63, 2, 2, $3)`,
    [STAGED_GENERATION_ID, SESSION_ID, AT]
  );
  await client.query(
    `INSERT INTO agent_component_invocation_parts (
       id, generation_id, part_index, part_hash, item_count, payload_bytes
     ) VALUES ($1, $2, 0, 'part-hash-1', 3, 1)`,
    [PART_ID, GENERATION_ID]
  );
  await client.query(
    `INSERT INTO agent_component_invocation_parts (
       id, generation_id, part_index, part_hash, item_count, payload_bytes
     ) VALUES ($1, $2, 0, 'part-hash-2', 1, 1)`,
    [STAGED_PART_ID, STAGED_GENERATION_ID]
  );
  await client.query(
    `INSERT INTO agent_component_invocations (
       id, generation_id, part_id, external_invocation_id, source_session_id,
       component_kind, component_key, normalized_name, relationship, sequence,
       anchor, attribution_status, evidence_class, agent_component_id, updated_at
     ) VALUES
       ($1, $8, $9, 'ext-skill',   'external-iss4778', 'skill',   $4,  $4,  'direct', 0, '{}'::jsonb, 'matched', 'transcriptSnapshot', $5, $10),
       ($2, $8, $9, 'ext-phantom', 'external-iss4778', 'command', $11, $11, 'direct', 1, '{}'::jsonb, 'matched', 'transcriptSnapshot', $6, $10),
       ($3, $8, $9, 'ext-genuine', 'external-iss4778', 'command', $12, $12, 'direct', 2, '{}'::jsonb, 'matched', 'transcriptSnapshot', $7, $10)`,
    [
      SKILL_INVOCATION_ID,
      PHANTOM_INVOCATION_ID,
      GENUINE_INVOCATION_ID,
      SKILL_KEY,
      SKILL_COMPONENT_ID,
      PHANTOM_COMPONENT_ID,
      GENUINE_COMPONENT_ID,
      GENERATION_ID,
      PART_ID,
      AT,
      PHANTOM_KEY,
      GENUINE_KEY,
    ]
  );
  await client.query(
    `INSERT INTO agent_component_invocations (
       id, generation_id, part_id, external_invocation_id, source_session_id,
       component_kind, component_key, normalized_name, relationship, sequence,
       anchor, attribution_status, evidence_class, agent_component_id, updated_at
     ) VALUES
       ($1, $2, $3, 'ext-staged-phantom', 'external-iss4778', 'command', $4, $4,
        'direct', 0, '{}'::jsonb, 'matched', 'transcriptSnapshot', $5, $6)`,
    [
      STAGED_PHANTOM_INVOCATION_ID,
      STAGED_GENERATION_ID,
      STAGED_PART_ID,
      PHANTOM_KEY,
      PHANTOM_COMPONENT_ID,
      AT,
    ]
  );
}

/**
 * Four rollup rows: the skill on the default branch (the collision target), the
 * phantom on the SAME branch (must merge by summing), the phantom on a branch
 * with no skill row (must simply re-point), and a genuine command (untouched).
 */
async function seedUsage(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO agent_component_session_usage (
       id, agent_session_id, component_kind, component_key, git_branch,
       agent_component_id, invocation_count, error_count, updated_at
     ) VALUES
       ($1, $5, 'skill',   $9,  $11, $6, 2, 1, $8),
       ($2, $5, 'command', $10, $11, $7, 3, 2, $8),
       ($3, $5, 'command', $10, $12, $7, 4, 0, $8),
       ($4, $5, 'command', $13, $11, $14, 7, 0, $8)`,
    [
      SKILL_USAGE_ID,
      PHANTOM_USAGE_COLLIDING_ID,
      PHANTOM_USAGE_UNIQUE_BRANCH_ID,
      GENUINE_USAGE_ID,
      SESSION_ID,
      SKILL_COMPONENT_ID,
      PHANTOM_COMPONENT_ID,
      AT,
      SKILL_KEY,
      PHANTOM_KEY,
      BRANCH_MAIN,
      BRANCH_FEATURE,
      GENUINE_KEY,
      GENUINE_COMPONENT_ID,
    ]
  );
}

async function seedSearchDocuments(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO search_document (id, organization_id, entity_type, entity_id, title, updated_at)
     VALUES ($1, $3, $4, $5, '/review', $7),
            ($2, $3, $4, $6, '/deploy', $7)`,
    [
      SEARCH_PHANTOM_ID,
      SEARCH_GENUINE_ID,
      ORG_ID,
      SearchEntityType.AgentComponent,
      PHANTOM_COMPONENT_ID,
      GENUINE_COMPONENT_ID,
      AT,
    ]
  );
}

/** A SECOND resolved `review` skill on the same target — an ambiguous install. */
async function seedSecondResolvedSkill(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO agent_components (
       id, organization_id, compute_target_id, component_kind,
       external_component_id, component_key, resolved_state, content, updated_at
     ) VALUES ($1, $2, $3, $4, 'skill:review@project', $5, $6, '# Review', $7)`,
    [
      SECOND_SKILL_COMPONENT_ID,
      ORG_ID,
      TARGET_ID,
      AgentComponentKind.Skill,
      SKILL_KEY,
      ComponentResolvedState.Resolved,
      AT,
    ]
  );
}

/** A GENUINE resolved `/review` command sharing the phantom's key on the target. */
async function seedResolvedSameKeyCommand(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO agent_components (
       id, organization_id, compute_target_id, component_kind,
       external_component_id, component_key, resolved_state, content, updated_at
     ) VALUES ($1, $2, $3, $4, 'command:review', $5, $6, '# Review command', $7)`,
    [
      RESOLVED_COMMAND_ID,
      ORG_ID,
      TARGET_ID,
      AgentComponentKind.Command,
      PHANTOM_KEY,
      ComponentResolvedState.Resolved,
      AT,
    ]
  );
}

/**
 * An invocation + usage bucket keyed `/review` whose inventory link is still
 * NULL — the migration-window shape produced when a row syncs before its
 * inventory row does.
 */
async function seedUnlinkedPhantomKeyedRows(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO agent_component_invocations (
       id, generation_id, part_id, external_invocation_id, source_session_id,
       component_kind, component_key, normalized_name, relationship, sequence,
       anchor, attribution_status, evidence_class, agent_component_id, updated_at
     ) VALUES ($1, $2, $3, 'ext-unlinked', 'external-iss4778', $4, $5, $5,
               'direct', 3, '{}'::jsonb, 'matched', 'transcriptSnapshot', NULL, $6)`,
    [
      UNLINKED_INVOCATION_ID,
      GENERATION_ID,
      PART_ID,
      AgentComponentKind.Command,
      PHANTOM_KEY,
      AT,
    ]
  );
  await client.query(
    `INSERT INTO agent_component_session_usage (
       id, agent_session_id, component_kind, component_key, git_branch,
       agent_component_id, invocation_count, error_count, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NULL, 1, 0, $6)`,
    [
      UNLINKED_USAGE_ID,
      SESSION_ID,
      AgentComponentKind.Command,
      PHANTOM_KEY,
      BRANCH_OTHER,
      AT,
    ]
  );
}

async function readInvocationIdentity(client: Client, invocationId: string) {
  const result = await client.query(
    `SELECT component_kind, component_key, agent_component_id
       FROM agent_component_invocations WHERE id = $1`,
    [invocationId]
  );
  return result.rows[0];
}

async function readInvocations(client: Client) {
  const result = await client.query(
    `SELECT id, component_kind, component_key, normalized_name, agent_component_id
       FROM agent_component_invocations
      WHERE generation_id = $1
      ORDER BY sequence`,
    [GENERATION_ID]
  );
  return result.rows;
}

async function readStagedInvocationIdentities(client: Client) {
  const result = await client.query(
    `SELECT id, component_kind, component_key, normalized_name
       FROM agent_component_invocations
      WHERE generation_id = $1
      ORDER BY sequence`,
    [STAGED_GENERATION_ID]
  );
  return result.rows;
}

async function readUsage(client: Client) {
  const result = await client.query(
    `SELECT component_kind, component_key, git_branch, agent_component_id,
            invocation_count, error_count
       FROM agent_component_session_usage
      WHERE agent_session_id = $1
      ORDER BY component_kind, git_branch`,
    [SESSION_ID]
  );
  return result.rows;
}

async function readComponentIds(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM agent_components
      WHERE organization_id = $1
      ORDER BY external_component_id, compute_target_id`,
    [ORG_ID]
  );
  return result.rows.map((row) => row.id);
}

async function readSearchEntityIds(client: Client): Promise<string[]> {
  const result = await client.query<{ entity_id: string }>(
    `SELECT entity_id FROM search_document
      WHERE organization_id = $1 AND entity_type = $2
      ORDER BY title`,
    [ORG_ID, SearchEntityType.AgentComponent]
  );
  return result.rows.map((row) => row.entity_id);
}
