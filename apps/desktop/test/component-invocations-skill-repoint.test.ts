/**
 * @file component-invocations-skill-repoint.test.ts
 * @description ISS-5260: a slash-invoked SKILL keeps ONE record — the skill.
 *
 * The prior skill-shadow work (ISS-4775 / ISS-4810 / ISS-4811) only suppressed a
 * slash invocation it could PAIR with a `Skill` tool_use of the same bare name.
 * The dominant real shape has no partner to pair with — Claude Code expands a
 * slash-invoked skill without emitting a `Skill` tool_use at all (golden session
 * `3b820c31` invokes `/code-review:deep` with four unrelated `Skill` tool_uses
 * and none for `code-review:deep`) — so the Command candidate survived and minted
 * an `agent_components` row beside the resolved skill row. Two records for one
 * entity, with the invocations and modal usage on one and the definition on the
 * other.
 *
 * These drive the PRODUCTION import path (`importSession` →
 * `materializeAgentComponentInvocations`) and the stored-row rebuild bridge, and
 * assert the Command record is ABSENT rather than merely that a Skill exists.
 *
 * Split into its own file rather than added to
 * `component-invocations-materialization.test.ts`, which is grandfathered
 * shrink-only (root AGENTS.md → File Size and Organization).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { ComponentResolvedState } from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { NormalizedDefinitionKind } from "@repo/lib/harness/types";
import type { AgentComponentInvocationCandidate } from "../src/main/database/component-invocation-row-writer.js";
import { repointSkillInvokedCommandCandidates } from "../src/main/database/component-invocation-skill-repoint.js";
import { EVENT_INSERT_PARAM_CAP } from "../src/main/database/db-constants.js";
import type { Prisma } from "../src/main/database/generated/client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { staleRebuildFromStoredRows } from "./helpers/stored-rebuild.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-05T17:00:00.000Z";
/**
 * The older `SQLITE_MAX_VARIABLE_NUMBER` the desktop store must stay safe on —
 * the floor `EVENT_INSERT_PARAM_CAP` is derived from. Named here so the boundary
 * assertion reads as the contract rather than a bare literal.
 */
const SQLITE_VARIABLE_FLOOR = 999;
const INVOKED_AT = "2026-08-05T17:00:01.000Z";
const SKILL_KEY = "prune-tests";
const SLASH_KEY = "/prune-tests";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

describe("ISS-5260 slash-invoked skill resolves to ONE Skill record", () => {
  test("an unpaired slash invocation of a resolved skill mints no Command record", async () => {
    await withDb("aci-repoint-one-record-", async (db) => {
      await insertResolvedSkill(db, SKILL_KEY);
      await db.importer.importSession(
        unpairedSlashSession("session-repoint-one", 1),
        "claude"
      );

      // The command half is gone at EVERY layer it used to appear: no
      // invocation, no inventory component, no usage rollup.
      assert.deepEqual(
        await invocationKeys(db, "session-repoint-one", Kind.Command),
        []
      );
      assert.deepEqual(await componentKeys(db, Kind.Command), []);
      assert.deepEqual(
        await usageKeys(db, "session-repoint-one", Kind.Command),
        []
      );
      // …and the invocation evidence landed on the skill that holds the
      // definition, rather than being dropped.
      assert.deepEqual(
        await invocationKeys(db, "session-repoint-one", Kind.Skill),
        [SKILL_KEY]
      );
      assert.deepEqual(await usageKeys(db, "session-repoint-one", Kind.Skill), [
        SKILL_KEY,
      ]);
    });
  });

  // The control that proves this NARROWED the `command` kind rather than
  // collapsing it: `command` is still reserved for things that are genuinely
  // commands, and a genuine command still produces a Command record.
  test("a genuine command with no same-named skill still produces a Command record", async () => {
    await withDb("aci-repoint-genuine-", async (db) => {
      await insertResolvedSkill(db, SKILL_KEY);
      await db.importer.importSession(
        makeSession({
          sessionId: "session-genuine-command",
          startedAt: NOW,
          endedAt: "2026-08-05T17:05:00.000Z",
          messages: [{ role: "human", timestamp: INVOKED_AT, text: "/deploy" }],
          slashCommands: [{ name: "/deploy", timestamp: INVOKED_AT }],
        }),
        "claude"
      );

      assert.deepEqual(
        await invocationKeys(db, "session-genuine-command", Kind.Command),
        ["/deploy"]
      );
      assert.deepEqual(await componentKeys(db, Kind.Command), ["/deploy"]);
      assert.deepEqual(
        await usageKeys(db, "session-genuine-command", Kind.Command),
        ["/deploy"]
      );
    });
  });

  // The harder control: the slash key and the skill DO share a bare name, but a
  // `.claude/commands/deploy.md` vouches for the command, so they are two real
  // entities and BOTH records survive.
  test("a vouched command sharing a skill's bare name keeps both records", async () => {
    await withDb("aci-repoint-vouched-", async (db) => {
      await insertResolvedSkill(db, "deploy");
      await insertCommandComponent(db, "/deploy", "# Deploy the thing");
      await db.importer.importSession(
        makeSession({
          sessionId: "session-vouched",
          startedAt: NOW,
          endedAt: "2026-08-05T17:05:00.000Z",
          messages: [{ role: "human", timestamp: INVOKED_AT, text: "/deploy" }],
          slashCommands: [{ name: "/deploy", timestamp: INVOKED_AT }],
        }),
        "claude"
      );

      assert.deepEqual(
        await invocationKeys(db, "session-vouched", Kind.Command),
        ["/deploy"]
      );
      assert.deepEqual(await componentKeys(db, Kind.Command), ["/deploy"]);
    });
  });

  // ISS-4923's widening, on the collector side: a command whose
  // `.claude/commands/deploy.md` synced with content but has NOT been promoted to
  // `resolved` vouches for itself too. Seeded UNRESOLVED so the `resolved_state`
  // arm alone cannot satisfy the assertion — deleting the content check would
  // turn this red.
  test("an UNRESOLVED command carrying its own definition text still vouches", async () => {
    await withDb("aci-repoint-content-vouch-", async (db) => {
      await insertResolvedSkill(db, "deploy");
      await insertUnresolvedCommandWithContent(db, "/deploy", "# Deploy it");
      await db.importer.importSession(
        makeSession({
          endedAt: "2026-08-05T17:05:00.000Z",
          messages: [{ role: "human", text: "/deploy", timestamp: INVOKED_AT }],
          sessionId: "session-content-vouched",
          slashCommands: [{ name: "/deploy", timestamp: INVOKED_AT }],
          startedAt: NOW,
        }),
        "claude"
      );

      assert.deepEqual(
        await invocationKeys(db, "session-content-vouched", Kind.Command),
        ["/deploy"]
      );
    });
  });

  // ISS-5260 / M1: the leading-slash-run population ISS-4795 documented. A
  // `//deploy` entry carrying a REAL resolving snapshot has neither
  // `definitionHash` nor `definitionContent` — `exactEvidence` compares the
  // snapshot's un-normalized `normalizedName` against the NORMALIZED key and
  // misses — so a re-point inferring genuineness from those fields would fold a
  // command the per-occurrence correlation explicitly protects. The candidate's
  // `commandDefinitionWitness` is what keeps the two guards in agreement.
  test("a double-slashed command with a resolving snapshot is never folded", async () => {
    await withDb("aci-repoint-slashrun-", async (db) => {
      await insertResolvedSkill(db, "deploy");
      await db.importer.importSession(
        makeSession({
          endedAt: "2026-08-05T17:05:00.000Z",
          messages: [
            { role: "human", text: "//deploy", timestamp: INVOKED_AT },
          ],
          sessionId: "session-slash-run",
          slashCommands: [
            {
              definitionSnapshot: {
                capturedAt: INVOKED_AT,
                content: "---\nname: deploy\n---\nShip it.\n",
                kind: NormalizedDefinitionKind.Command,
                normalizedName: "//deploy",
                rawName: "//deploy",
              },
              name: "//deploy",
              timestamp: INVOKED_AT,
            },
          ],
          startedAt: NOW,
        }),
        "claude"
      );

      assert.deepEqual(
        await invocationKeys(db, "session-slash-run", Kind.Command),
        ["/deploy"]
      );
      assert.deepEqual(
        await invocationKeys(db, "session-slash-run", Kind.Skill),
        []
      );
    });
  });

  // An unresolved skill row is a name observed in passing, not proof a skill
  // definition exists — so it must NOT absorb a slash invocation. Without this,
  // the very first `/foo` would mint an unresolved `foo` skill row that then
  // "proved" the next `/foo` was a skill invocation.
  test("an UNRESOLVED same-named skill does not absorb the slash invocation", async () => {
    await withDb("aci-repoint-unresolved-", async (db) => {
      await insertSkillComponent(
        db,
        SKILL_KEY,
        ComponentResolvedState.Unresolved
      );
      await db.importer.importSession(
        unpairedSlashSession("session-unresolved-skill", 1),
        "claude"
      );

      assert.deepEqual(
        await invocationKeys(db, "session-unresolved-skill", Kind.Command),
        [SLASH_KEY]
      );
    });
  });
});

describe("ISS-5260 inventory read stays inside the SQLite bind budget", () => {
  // wongk review: the inventory read binds each distinct bare name TWICE (bare
  // for the skill arm, slash-prefixed for the command arm) plus three fixed
  // parameters, so an unchunked statement costs `3 + 2n` binds and crosses the
  // 999-variable floor `EVENT_INSERT_PARAM_CAP` documents at 499 names — rolling
  // back the WHOLE import transaction on any build carrying that older limit.
  //
  // Two assertions, because neither alone is sufficient. The bind-count capture
  // pins the BUDGET deterministically (this host's libSQL is a newer 32766-limit
  // build, so an unchunked statement would execute here and the end-to-end
  // import alone would stay green on a store that a 999-limit build rejects),
  // and the re-point assertions prove chunking did not change the DECISION. Both
  // run against a real SQLite store through the production entry point.
  test("distinct slash keys above the boundary are read within the bind cap", async () => {
    await withDb("aci-repoint-bind-floor-", async (db) => {
      const distinctNames = 600;
      assert.ok(distinctNames * 2 + 3 > SQLITE_VARIABLE_FLOOR);
      await insertResolvedSkill(db, SKILL_KEY);
      const candidates = slashCommandCandidates(distinctNames);
      const bindCounts: number[] = [];
      const tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe"> = {
        $queryRawUnsafe: (sql, ...params) => {
          bindCounts.push(params.length);
          return db.prisma.client.$queryRawUnsafe(sql, ...params);
        },
      };

      const repointed = await repointSkillInvokedCommandCandidates(
        tx,
        candidates
      );

      assert.ok(bindCounts.length > 1, "the read must have been chunked");
      for (const count of bindCounts) {
        assert.ok(
          count <= EVENT_INSERT_PARAM_CAP,
          `statement bound ${count} parameters, above the ${EVENT_INSERT_PARAM_CAP} cap`
        );
      }
      // Chunking changed nothing about the outcome: the one name answering to a
      // resolved skill is re-pointed, every other slash key stays a command.
      assert.deepEqual(repointed, [SLASH_KEY]);
      const skillCandidates = candidates.filter(
        (candidate) => candidate.componentKind === Kind.Skill
      );
      assert.deepEqual(
        skillCandidates.map((candidate) => candidate.componentKey),
        [SKILL_KEY]
      );
      assert.equal(
        candidates.filter(
          (candidate) => candidate.componentKind === Kind.Command
        ).length,
        distinctNames - 1
      );
    });
  });

  // The same population through the PRODUCTION import path, so the chunked read
  // is proven to survive inside the real import transaction and land the same
  // rows — not just to compute the right answer in isolation.
  test("a session with far more distinct slash keys than the bind floor imports", async () => {
    await withDb("aci-repoint-bind-floor-import-", async (db) => {
      const distinctNames = 600;
      await insertResolvedSkill(db, SKILL_KEY);

      await db.importer.importSession(
        manyDistinctSlashSession("session-bind-floor", distinctNames),
        "claude"
      );

      assert.deepEqual(
        await invocationKeys(db, "session-bind-floor", Kind.Skill),
        [SKILL_KEY]
      );
      const commandKeys = await invocationKeys(
        db,
        "session-bind-floor",
        Kind.Command
      );
      assert.equal(commandKeys.length, distinctNames - 1);
      assert.ok(!commandKeys.includes(SLASH_KEY));
    });
  });
});

describe("ISS-5260 rollups reconcile with no double-count", () => {
  test("three unpaired slash invocations roll up as three Skill invocations", async () => {
    await withDb("aci-repoint-rollup-", async (db) => {
      await insertResolvedSkill(db, SKILL_KEY);
      await db.importer.importSession(
        unpairedSlashSession("session-rollup", 3),
        "claude"
      );

      assert.equal(
        (await invocationKeys(db, "session-rollup", Kind.Skill)).length,
        3
      );
      assert.deepEqual(
        await invocationKeys(db, "session-rollup", Kind.Command),
        []
      );
      // The rollup the components view reads must agree with the invocation
      // rows — one bucket, three invocations, nothing left on a command bucket.
      assert.deepEqual(await usageRollup(db, "session-rollup"), [
        { componentKey: SKILL_KEY, componentKind: Kind.Skill, invocations: 3 },
      ]);
    });
  });

  // Composition check: correlation (ISS-4810) claims the two slash entries that
  // pair with a `Skill` tool_use, and the re-point takes the unpaired third.
  // Three user turns must still yield exactly three invocations — the re-point
  // must not re-add a row correlation already accounted for.
  //
  // This asserts the MERGED reading is correct, which holds when the unpaired
  // third turn was an unlogged slash expansion (the dominant shape). When it was
  // a `/prune-tests` the user escaped, the skill rolls up one invocation more
  // than fired — the transcript records the two identically, so no rule can
  // separate them. That deliberate tradeoff is recorded in the revision-68 note
  // in `data-revision.ts`; this test pins the reading the revision chose.
  test("two paired plus one unpaired slash invocation still total three", async () => {
    await withDb("aci-repoint-mixed-", async (db) => {
      await insertResolvedSkill(db, SKILL_KEY);
      await db.importer.importSession(mixedPairingSession(), "claude");

      assert.deepEqual(
        await invocationKeys(db, "session-mixed", Kind.Command),
        []
      );
      assert.equal(
        (await invocationKeys(db, "session-mixed", Kind.Skill)).length,
        3
      );
      assert.deepEqual(await usageRollup(db, "session-mixed"), [
        { componentKey: SKILL_KEY, componentKind: Kind.Skill, invocations: 3 },
      ]);
    });
  });
});

describe("ISS-5260 stored-row rebuild converges on the same set", () => {
  // ISS-4811's property: a session whose transcript is gone must rebuild to the
  // invocation set a reparse would produce. A rebuild that re-minted the phantom
  // would undo the repair on the next boot.
  test("the stored-row rebuild re-points the unpaired slash invocation too", async () => {
    await withDb("aci-repoint-stored-", async (db) => {
      await insertResolvedSkill(db, SKILL_KEY);
      await db.importer.importSession(
        unpairedSlashSession("session-stored-repoint", 1),
        "claude"
      );

      const rebuilt = await staleRebuildFromStoredRows(
        db,
        "session-stored-repoint"
      );

      assert.equal(rebuilt.rebuilt, true);
      assert.deepEqual(
        await invocationKeys(db, "session-stored-repoint", Kind.Command),
        []
      );
      assert.deepEqual(await componentKeys(db, Kind.Command), []);
      assert.deepEqual(
        await invocationKeys(db, "session-stored-repoint", Kind.Skill),
        [SKILL_KEY]
      );
    });
  });
});

const Kind = AgentComponentInvocationKind;

async function withDb(
  prefix: string,
  body: (db: Db) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await body(db);
  } finally {
    await db.close();
    await rm(dir, { force: true, recursive: true });
  }
}

/**
 * `count` user turns that typed `/prune-tests` with NO `Skill` tool_use — the
 * shape Claude Code actually records for a slash-invoked skill, and the one the
 * per-occurrence correlation has nothing to pair against.
 */
function unpairedSlashSession(
  sessionId: string,
  count: number
): ReturnType<typeof makeSession> {
  const timestamps = Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(INVOKED_AT) + index * 60_000).toISOString()
  );
  return makeSession({
    endedAt: "2026-08-05T17:30:00.000Z",
    messages: timestamps.map((timestamp) => ({
      role: "human" as const,
      text: SLASH_KEY,
      timestamp,
    })),
    sessionId,
    slashCommands: timestamps.map((timestamp) => ({
      name: SLASH_KEY,
      timestamp,
    })),
    startedAt: NOW,
  });
}

/**
 * `count` slash-keyed `command` candidates carrying no definition evidence —
 * exactly one of which (`/prune-tests`) answers to a resolved skill. The shape
 * the writer hands {@link repointSkillInvokedCommandCandidates}, built directly
 * so the bind budget can be observed at the statement boundary.
 */
function slashCommandCandidates(
  count: number
): AgentComponentInvocationCandidate[] {
  const names = [
    SLASH_KEY,
    ...Array.from(
      { length: count - 1 },
      (_, index) => `/bulk-command-${index}`
    ),
  ];
  return names.map((name, index) => ({
    agentId: null,
    anchorKind: AgentComponentInvocationAnchorKind.UserTurn,
    anchorValue: INVOKED_AT,
    attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
    childSessionId: null,
    componentKey: name,
    componentKind: Kind.Command,
    createdAt: NOW,
    definitionContent: null,
    definitionHash: null,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
    evidencePointer: null,
    externalInvocationId: `inv-bulk-${index}`,
    externalSourceId: null,
    gitBranch: null,
    invokedAt: INVOKED_AT,
    localComponentId: null,
    localComponentVersionId: null,
    normalizedName: name,
    normalizerContractVersion: null,
    parentAgentId: null,
    providerToolUseId: null,
    rawName: name,
    relationship: AgentComponentInvocationRelationship.Direct,
    repositoryFullName: null,
    sequence: index,
    sourceOrder: index,
    succeeded: null,
    updatedAt: NOW,
  }));
}

/**
 * `count` user turns, each typing a DISTINCT slash key, exactly one of which
 * (`/prune-tests`) answers to a resolved skill. Every distinct key becomes one
 * bare name in the inventory read, so this is the shape that exercises the
 * bind-count budget (wongk review).
 */
function manyDistinctSlashSession(
  sessionId: string,
  count: number
): ReturnType<typeof makeSession> {
  const names = [
    SLASH_KEY,
    ...Array.from(
      { length: count - 1 },
      (_, index) => `/bulk-command-${index}`
    ),
  ];
  const entries = names.map((name, index) => ({
    name,
    timestamp: new Date(Date.parse(INVOKED_AT) + index * 1000).toISOString(),
  }));
  return makeSession({
    endedAt: "2026-08-05T18:30:00.000Z",
    messages: entries.map((entry) => ({
      role: "human" as const,
      text: entry.name,
      timestamp: entry.timestamp,
    })),
    sessionId,
    slashCommands: entries,
    startedAt: NOW,
  });
}

/** Three `/prune-tests` turns, two of which fired a `Skill` tool_use. */
function mixedPairingSession(): ReturnType<typeof makeSession> {
  const timestamps = Array.from({ length: 3 }, (_, index) =>
    new Date(Date.parse(INVOKED_AT) + index * 60_000).toISOString()
  );
  const paired = timestamps.slice(0, 2);
  return makeSession({
    endedAt: "2026-08-05T17:30:00.000Z",
    messages: timestamps.map((timestamp) => ({
      role: "human" as const,
      text: SLASH_KEY,
      timestamp,
    })),
    sessionId: "session-mixed",
    skills: paired.map((timestamp, index) => ({
      name: SKILL_KEY,
      providerToolUseId: `toolu_prune_${index}`,
      timestamp,
    })),
    slashCommands: timestamps.map((timestamp) => ({
      name: SLASH_KEY,
      timestamp,
    })),
    startedAt: NOW,
    toolUses: paired.map((timestamp, index) => ({
      id: `toolu_prune_${index}`,
      kind: "harness" as const,
      name: "Skill",
      providerToolUseId: `toolu_prune_${index}`,
      skillName: SKILL_KEY,
      timestamp,
    })),
  });
}

function insertResolvedSkill(db: Db, componentKey: string): Promise<unknown> {
  return insertSkillComponent(
    db,
    componentKey,
    ComponentResolvedState.Resolved
  );
}

function insertSkillComponent(
  db: Db,
  componentKey: string,
  resolvedState: ComponentResolvedState
): Promise<unknown> {
  return db.run(
    `INSERT INTO agent_components
       (id, component_kind, external_id, component_key, resolved_state,
        content, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $6)`,
    `component-skill-${componentKey}`,
    Kind.Skill,
    componentKey,
    resolvedState,
    resolvedState === ComponentResolvedState.Resolved
      ? `---\nname: ${componentKey}\n---\nDo the thing.\n`
      : null,
    NOW
  );
}

/** A command that vouches for itself by carrying its own definition text. */
function insertCommandComponent(
  db: Db,
  componentKey: string,
  content: string
): Promise<unknown> {
  return db.run(
    `INSERT INTO agent_components
       (id, component_kind, external_id, component_key, resolved_state,
        content, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $6)`,
    `component-command-${componentKey}`,
    Kind.Command,
    componentKey,
    ComponentResolvedState.Resolved,
    content,
    NOW
  );
}

/**
 * A command that vouches ONLY by carrying its own definition text — its
 * `.claude/commands/<name>.md` synced but resolution has not promoted it yet.
 * Seeded unresolved on purpose so the `resolved_state` arm cannot satisfy the
 * assertion (ISS-4923's widening, collector side).
 */
function insertUnresolvedCommandWithContent(
  db: Db,
  componentKey: string,
  content: string
): Promise<unknown> {
  return db.run(
    `INSERT INTO agent_components
       (id, component_kind, external_id, component_key, resolved_state,
        content, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $6)`,
    `component-command-unresolved-${componentKey}`,
    Kind.Command,
    componentKey,
    ComponentResolvedState.Unresolved,
    content,
    NOW
  );
}

function invocationKeys(
  db: Db,
  sessionId: string,
  componentKind: string
): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ component_key: string }[]>(
      `SELECT component_key
         FROM agent_component_invocations
        WHERE session_id = $1 AND component_kind = $2
        ORDER BY component_key`,
      sessionId,
      componentKind
    )
    .then((rows) => rows.map((row) => row.component_key));
}

function componentKeys(db: Db, componentKind: string): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ component_key: string }[]>(
      `SELECT component_key
         FROM agent_components
        WHERE component_kind = $1
        ORDER BY component_key`,
      componentKind
    )
    .then((rows) => rows.map((row) => row.component_key));
}

function usageKeys(
  db: Db,
  sessionId: string,
  componentKind: string
): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ component_key: string }[]>(
      `SELECT component_key
         FROM agent_component_session_usage
        WHERE session_id = $1 AND component_kind = $2
        ORDER BY component_key`,
      sessionId,
      componentKind
    )
    .then((rows) => rows.map((row) => row.component_key));
}

/** The per-component rollup the components view reads, summed across buckets. */
function usageRollup(
  db: Db,
  sessionId: string
): Promise<
  Array<{ componentKey: string; componentKind: string; invocations: number }>
> {
  return db.prisma.client
    .$queryRawUnsafe<
      { component_key: string; component_kind: string; invocations: number }[]
    >(
      `SELECT component_kind, component_key, SUM(invocations) AS invocations
         FROM agent_component_session_usage
        WHERE session_id = $1
        GROUP BY component_kind, component_key
        ORDER BY component_kind, component_key`,
      sessionId
    )
    .then((rows) =>
      rows.map((row) => ({
        componentKey: row.component_key,
        componentKind: row.component_kind,
        invocations: Number(row.invocations),
      }))
    );
}
