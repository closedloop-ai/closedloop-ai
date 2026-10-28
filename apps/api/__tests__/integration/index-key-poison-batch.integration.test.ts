/**
 * ISS-8069 — an over-long value on an INDEXED column must not poison the batch
 * carrying it, proved against a real Postgres.
 *
 * This case cannot be made with mocks. The failure is Postgres's own: a btree
 * index tuple may not exceed 2704 bytes, so an over-long value on an indexed
 * column does not store badly, it makes the write THROW. Only the real engine
 * raises that, and the mocked batch/service suites stay green through every
 * mutation of this behaviour because their fake `upsert` accepts any string.
 *
 * NOT wrapped in `autoRollbackTransaction`, deliberately, unlike its neighbours.
 * The harm under test IS partial commit: the desktop-sync ingest gives each
 * session its own transaction and the component fan-out is not a transaction at
 * all, and wrapping the whole case in one outer transaction would erase exactly
 * the boundary the sibling-survival assertion is about. Isolation is by
 * per-test organization plus a cascading delete.
 *
 * The fixtures are literal byte counts and the assertions are against
 * POSTGRES's 2704, never against `INDEX_KEY_MAX_BYTES` — a test that sized its
 * input or its expectation from the constant under test would move with the bug
 * instead of catching it.
 */

import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  BTREE_INDEX_TUPLE_MAX_BYTES,
  buildSession,
  buildSessionsPayload,
  createSyncFixture,
  HEALTHY_HARNESS,
  HEALTHY_SESSION_ID,
  overLimitValue,
} from "@/__tests__/support/index-key-poison.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { desktopComponentsSyncService } from "@/app/desktop/components/sync/service";
import type { DesktopAgentComponentsPayload } from "@/lib/desktop-agent-sessions-schema";
import { projectIndexKey } from "@/lib/index-key-projection";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const OVER_LIMIT_VALUE = overLimitValue("iss-8069");
const OVER_LIMIT_ALTERNATE = overLimitValue("iss-8069-alternate");

const HEALTHY_COMPONENT_ID = "skill::healthy-sibling";
const HEALTHY_COMPONENT_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// The production entry points open their OWN transaction boundaries (one per
// session slice; none at all across the component fan-out), which is precisely
// what the sibling-survival assertion is about — so this suite commits for real
// and tears the graph down afterwards instead of wrapping everything in one
// rollback that would erase that boundary.
const organizations = createCommittedTestOrganizationTracker();

function createFixture() {
  return organizations
    .create()
    .then((organizationId) =>
      createSyncFixture(organizationId, "iss-8069-machine")
    );
}

type SyncedComponentInput = DesktopAgentComponentsPayload["components"][number];

function buildComponent(
  overrides: Partial<SyncedComponentInput>
): SyncedComponentInput {
  return {
    externalId: HEALTHY_COMPONENT_ID,
    componentKind: "skill",
    harness: "claude-code",
    name: "Healthy sibling",
    componentKey: "healthy-sibling",
    version: null,
    description: null,
    sourceUrl: null,
    installPath: ".claude/skills/healthy-sibling/SKILL.md",
    packId: null,
    scope: null,
    projectPath: null,
    metadata: null,
    content: "# healthy sibling",
    contentHash: HEALTHY_COMPONENT_HASH,
    ...overrides,
  } as SyncedComponentInput;
}

function buildComponentsPayload(
  components: SyncedComponentInput[]
): DesktopAgentComponentsPayload {
  return {
    schemaVersion: 1,
    batchId: "5d2e0a41-7c3b-4f2e-8a9d-1b6c4e5f7a80",
    syncMode: AgentSessionSyncMode.Incremental,
    componentCount: components.length,
    components,
  } as DesktopAgentComponentsPayload;
}

function readSessions(computeTargetId: string) {
  return withDb((db) =>
    db.sessionDetail.findMany({
      where: { computeTargetId },
      select: {
        externalSessionId: true,
        harness: true,
        model: true,
        repositoryFullName: true,
      },
    })
  );
}

function readComponents(computeTargetId: string) {
  return withDb((db) =>
    db.agentComponent.findMany({
      where: { computeTargetId },
      select: {
        externalComponentId: true,
        contentHash: true,
        content: true,
      },
    })
  );
}

/** The stored byte length of every index-key column on this row. */
function indexKeyByteLengths(row: {
  externalSessionId: string;
  harness: string;
  model: string | null;
  repositoryFullName: string | null;
}): number[] {
  return [row.externalSessionId, row.harness, row.model, row.repositoryFullName]
    .filter((value): value is string => value !== null)
    .map((value) => Buffer.byteLength(value, "utf8"));
}

afterEach(async () => {
  await organizations.cleanup();
});

describeIfDb(
  "ISS-8069 — over-long index keys must not poison a sync batch",
  () => {
    it("persists a session whose harness, model, repository and id all exceed the btree tuple limit, and leaves its batch sibling durable", async () => {
      const fixture = await createFixture();

      // The healthy sibling goes FIRST so it has already COMMITTED its own
      // transaction by the time the poison session is applied. That ordering is
      // what makes this a partial-commit case rather than a plain rejection.
      await agentSessionsService.upsertSessions(
        {
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          computeTargetId: fixture.computeTargetId,
        },
        buildSessionsPayload([
          buildSession({}),
          buildSession({
            externalSessionId: `ext-poison-${OVER_LIMIT_VALUE}`,
            harness: OVER_LIMIT_VALUE,
            model: OVER_LIMIT_VALUE,
            attribution: {
              repositoryFullName: `acme/${OVER_LIMIT_VALUE}`,
              worktreePath: null,
              sourceArtifactId: null,
              sourceLoopId: null,
              baseBranch: null,
            },
          }),
        ])
      );

      const rows = await readSessions(fixture.computeTargetId);

      // Both landed: the batch completed AND the poison row is retrievable.
      expect(rows).toHaveLength(2);

      // The sibling is untouched — the assertion the whole ticket turns on. An
      // error-free result on the poison row alone would miss a partial commit
      // entirely.
      const sibling = rows.find(
        (row) => row.externalSessionId === HEALTHY_SESSION_ID
      );
      expect(sibling?.harness).toBe(HEALTHY_HARNESS);
      expect(sibling?.model).toBe("claude-opus");

      // The poison row is present and every one of its index keys is small
      // enough for the engine to have indexed it.
      const poison = rows.find(
        (row) => row.externalSessionId !== HEALTHY_SESSION_ID
      );
      expect(poison).toBeDefined();
      expect(poison?.harness).not.toBe("");
      expect(poison?.repositoryFullName).not.toBeNull();
      // All four landed small enough for the engine to have indexed them, and
      // none landed EMPTY — a bound key still identifies its row.
      const storedKeyBytes = poison ? indexKeyByteLengths(poison) : [];
      expect(storedKeyBytes).toHaveLength(4);
      for (const byteLength of storedKeyBytes) {
        expect(byteLength).toBeGreaterThan(0);
        expect(byteLength).toBeLessThan(BTREE_INDEX_TUPLE_MAX_BYTES);
      }
    });

    it("re-syncing the same over-long session resolves to the same row instead of minting a second", async () => {
      const fixture = await createFixture();
      const context = {
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        computeTargetId: fixture.computeTargetId,
      };
      const poison = buildSession({
        externalSessionId: `ext-poison-${OVER_LIMIT_VALUE}`,
        harness: OVER_LIMIT_VALUE,
      });

      await agentSessionsService.upsertSessions(
        context,
        buildSessionsPayload([poison])
      );
      await agentSessionsService.upsertSessions(
        context,
        buildSessionsPayload([poison])
      );

      // The projected key is a pure function of the original, so the second
      // delivery is an UPDATE of the first row. A non-deterministic bound would
      // show up here as two rows for one session.
      expect(await readSessions(fixture.computeTargetId)).toHaveLength(1);
    });

    it("keeps two DIFFERENT over-long session ids on two different rows", async () => {
      const fixture = await createFixture();

      // The positive sibling of the idempotence case above, and the failure a
      // plain truncation would produce: these two ids differ only past the point
      // any prefix-only bound would keep, so folding them together would silently
      // merge two distinct sessions into one row.
      await agentSessionsService.upsertSessions(
        {
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          computeTargetId: fixture.computeTargetId,
        },
        buildSessionsPayload([
          buildSession({ externalSessionId: `ext-poison-${OVER_LIMIT_VALUE}` }),
          buildSession({
            externalSessionId: `ext-poison-${OVER_LIMIT_ALTERNATE}`,
          }),
        ])
      );

      const rows = await readSessions(fixture.computeTargetId);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.externalSessionId)).size).toBe(2);
    });

    it("syncs a component inventory whose content hash exceeds the tuple limit, and leaves its batch sibling durable", async () => {
      const fixture = await createFixture();

      // The component fan-out is fail-fast and NOT a transaction, so on the
      // unfixed path the over-long hash aborts the request after siblings have
      // already committed — the poison batch this ticket names, retried whole and
      // forever by the desktop.
      const result = await desktopComponentsSyncService.sync({
        clerkUserId: null,
        computeTargetId: fixture.computeTargetId,
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        payload: buildComponentsPayload([
          buildComponent({}),
          buildComponent({
            externalId: "skill::poison",
            componentKey: "poison",
            content: "# poison",
            contentHash: OVER_LIMIT_VALUE,
          }),
        ]),
      });

      expect(result.ok).toBe(true);

      const rows = await readComponents(fixture.computeTargetId);
      expect(rows).toHaveLength(2);

      const sibling = rows.find(
        (row) => row.externalComponentId === HEALTHY_COMPONENT_ID
      );
      expect(sibling?.contentHash).toBe(HEALTHY_COMPONENT_HASH);

      const poison = rows.find(
        (row) => row.externalComponentId === "skill::poison"
      );
      expect(poison).toBeDefined();
      expect(Buffer.byteLength(poison?.contentHash ?? "", "utf8")).toBeLessThan(
        BTREE_INDEX_TUPLE_MAX_BYTES
      );
      // The definition text is NOT indexed and must survive whole — bounding the
      // hash must not cost the content it describes.
      expect(poison?.content).toBe("# poison");
    });
  }
);

/**
 * ISS-8254 — the projected namespace, proved reserved against a real Postgres.
 *
 * The unit suite proves `projectIndexKey` is injective. This proves the thing
 * that actually matters: that two distinct identities reach two distinct ROWS
 * under the live `@@unique([computeTargetId, externalSessionId])` btree, through
 * the production ingest, with no mock in the path deciding the answer.
 *
 * It is a same-scope attack, not a cross-tenant one, and the fixture says so by
 * construction: both deliveries run against ONE `computeTargetId`. Both the
 * unique constraint and the transcript S3 object key are prefixed by
 * `organizationId` and `computeTargetId`, which are server-derived from the
 * authenticated caller, so the tenant boundary was never the thing at risk — the
 * merge of two sessions inside one compute target was.
 */
describeIfDb("ISS-8254 — the projected index-key namespace is reserved", () => {
  it("keeps a long session id and a replay of its projected key on two different rows", async () => {
    const fixture = await createFixture();

    // What an attacker submits: the exact string the ingest stores for the long
    // identity, read back and replayed as a raw `externalSessionId`. Derived
    // from the production projection rather than hand-written, so it tracks the
    // real stored format instead of a guess about it.
    const longSessionId = `ext-poison-${OVER_LIMIT_VALUE}`;
    const replayedProjectedKey = projectIndexKey(longSessionId).value;

    await agentSessionsService.upsertSessions(
      {
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        computeTargetId: fixture.computeTargetId,
      },
      buildSessionsPayload([
        buildSession({ externalSessionId: longSessionId }),
        buildSession({ externalSessionId: replayedProjectedKey }),
      ])
    );

    const rows = await readSessions(fixture.computeTargetId);

    // Two sessions in, two rows out. On the unfixed path the second delivery
    // projected to itself, hit the first row's unique key and UPDATED it: one
    // row, two identities merged. This asserts the STORED-ROW collision only —
    // the transcript S3 object key is derived from the RAW `externalSessionId`
    // (`resolveTranscriptObjectKey`), so the two identities always addressed
    // different objects and there is no S3 collision to demonstrate here.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.externalSessionId)).size).toBe(2);

    // The long identity keeps the key ISS-8069 gave it. Reserving the namespace
    // must not re-key rows that were already being projected correctly.
    expect(
      rows.some((row) => row.externalSessionId === replayedProjectedKey)
    ).toBe(true);
  });

  it("re-syncing the replayed key stays on its own row instead of adopting the long session's", async () => {
    const fixture = await createFixture();
    const context = {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      computeTargetId: fixture.computeTargetId,
    };
    const longSessionId = `ext-poison-${OVER_LIMIT_VALUE}`;
    const replayedProjectedKey = projectIndexKey(longSessionId).value;

    // Long identity FIRST, so its row is already committed under the replayed
    // key by the time the attacker's delivery arrives. This is the read-side
    // half of the fix: the candidate list must not offer the replayed value's
    // own raw form back and route this write onto the row above.
    await agentSessionsService.upsertSessions(
      context,
      buildSessionsPayload([buildSession({ externalSessionId: longSessionId })])
    );
    await agentSessionsService.upsertSessions(
      context,
      buildSessionsPayload([
        buildSession({ externalSessionId: replayedProjectedKey }),
      ])
    );
    await agentSessionsService.upsertSessions(
      context,
      buildSessionsPayload([
        buildSession({ externalSessionId: replayedProjectedKey }),
      ])
    );

    // Three deliveries, two identities, two rows — and the repeat delivery is
    // still idempotent for the attacker's own identity.
    expect(await readSessions(fixture.computeTargetId)).toHaveLength(2);
  });
});
