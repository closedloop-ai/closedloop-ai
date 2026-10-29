/**
 * ISS-8604 — the ingest upsert's CREATE arm, proven against real Postgres.
 *
 * The unit suites beside this one (`service.upsert-awaiting.test.ts`) assert the
 * OBJECT handed to Prisma: they stub a stored row, read both arms out of the one
 * `upsert` call, and never make a database choose between them. That leaves the
 * thing this ticket is actually about untested (review, whitlockk) — the read →
 * delete → upsert ORDERING, and which arm Postgres therefore takes. Every case
 * here drives the real ingress contract (`parseDesktopAgentSessionsPayload` +
 * `agentSessionsService.upsertSessions`) and reads the PERSISTED row back.
 *
 * The racer is a deleter that takes no advisory lock — retention, phantom
 * retention — committing between the slice's `existing` read and its upsert.
 * `midSliceInterleave` puts the delete in exactly that window on ONE connection,
 * so the ordering is deterministic rather than two connections racing. It models
 * the ORDERING, not lock contention, which is the other half and which no
 * deterministic test can hold still.
 */
import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import {
  LEGACY_WAITING_WIRE_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  buildSessionChunk,
  createComputeTarget,
  ingestChunk,
  readPersistedChunkState,
  readPersistedTilingStartsMs,
} from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";

/**
 * A seam INSIDE `upsertSessionSlice`, between its pre-upsert `existing` read and
 * the upsert itself. `resolveDegradedMetadataPersist` is awaited in exactly that
 * window and is otherwise inert here (no payload declares withheld keys), so
 * arming this orders the sweep against the write deterministically.
 *
 * Unarmed it is a pass-through, so a case that does not arm it is unaffected.
 */
const midSliceInterleave = vi.hoisted(
  (): { run: (() => Promise<void>) | null } => ({ run: null })
);
vi.mock("./service/degraded-metadata-merge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./service/degraded-metadata-merge")>();
  return {
    ...actual,
    resolveDegradedMetadataPersist: async (
      ...args: Parameters<typeof actual.resolveDegradedMetadataPersist>
    ) => {
      const resolved = await actual.resolveDegradedMetadataPersist(...args);
      const hook = midSliceInterleave.run;
      midSliceInterleave.run = null;
      await hook?.();
      return resolved;
    },
  };
});

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

const SESSION_NAME = "ISS-8604 create-arm race";
const REPO_FULL_NAME = "acme/web";
const BRANCH_NAME = "feat/iss8604";
const PR_NUMBER = 8604;
const OBSERVED_AT = "2026-06-10T10:30:00.000Z";
/** Strictly OLDER than the payloads below, so a resync reads as fresh. */
const SEED_UPDATED_AT = "2026-06-10T11:00:00.000Z";
const RESYNC_UPDATED_AT = "2026-06-10T12:00:00.000Z";
/** Strictly NEWER than the racing payload's, so that payload is STALE. */
const STORED_UPDATED_AT = "2026-06-11T09:00:00.000Z";
/**
 * The racing payload's OWN start. `resolveIngestAwaitingInputSince` synthesizes
 * from `lastActivityAt ?? startedAt`, and the desktop wire schema carries no
 * `lastActivityAt`, so through the real ingress the start IS the synthesized
 * tier. Distinct from {@link SWEPT_ANCHOR} so the assertion tells them apart.
 */
const PAYLOAD_STARTED_AT = "2026-06-10T09:45:00.000Z";
const SWEPT_ANCHOR = new Date("2026-06-01T07:00:00.000Z");
const SWEPT_AGENT_ID = "swept-agent";
const PAYLOAD_AGENT_ID = "payload-agent";
const CHUNK_REVISION = 42;
/** A top-level `metadata` key the sweep deletes and the payload declares withheld. */
const WITHHELD_KEY = "usageExtras";
const SWEPT_WITHHELD_VALUE = { web_search_requests: 7 };
/** A minted session slug. `null` is the create-arm defect this pins. */
const SESSION_SLUG_PATTERN = /^SES-\d+$/;

type Fixture = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  externalSessionId: string;
  artifactId: string;
};

function buildAgent(externalAgentId: string) {
  return {
    externalAgentId,
    name: externalAgentId,
    type: "primary",
    status: SESSION_STATUS.ACTIVE,
  };
}

/** Import one session the way the desktop does, and resolve its cloud ids. */
async function importSession(
  externalSessionId: string,
  session: Record<string, unknown> = {}
): Promise<Fixture> {
  const organizationId = await createTestOrganization();
  const owner = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    owner.id,
    "lane-8604"
  );
  await ingestChunk(
    { organizationId, userId: owner.id, computeTargetId },
    randomUUID(),
    {
      ...buildSessionChunk({
        externalSessionId,
        name: SESSION_NAME,
        eventIds: ["evt-0"],
      }),
      updatedAt: SEED_UPDATED_AT,
      ...session,
    }
  );
  const detail = await readSessionDetail(computeTargetId, externalSessionId);
  return {
    organizationId,
    userId: owner.id,
    computeTargetId,
    externalSessionId,
    artifactId: detail.artifactId,
  };
}

function readSessionDetail(computeTargetId: string, externalSessionId: string) {
  return withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: {
        artifactId: true,
        agents: true,
        agentCount: true,
        awaitingInputSince: true,
        pullRequests: true,
        metadata: true,
        artifact: { select: { status: true, slug: true } },
      },
    })
  );
}

/** Re-run the collector over the same session. */
function reimport(
  fixture: Fixture,
  session: Record<string, unknown>
): Promise<string[]> {
  return ingestChunk(
    {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      computeTargetId: fixture.computeTargetId,
    },
    randomUUID(),
    session
  );
}

/**
 * The sweep. Deleting the ARTIFACT is what retention does, and
 * `SessionDetail.artifact` is `onDelete: Cascade`, so the detail row and its
 * events go with it — leaving the apply holding a snapshot of a row Postgres no
 * longer has.
 */
function sweep(artifactId: string): Promise<void> {
  return withDb(async (db) => {
    await db.artifact.delete({ where: { id: artifactId } });
  });
}

function pullRequestRef(): Record<string, unknown> {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: REPO_FULL_NAME,
    prNumber: PR_NUMBER,
    branchName: BRANCH_NAME,
    method: ArtifactRefMethod.PrCreateOutput,
    relation: ArtifactRefRelation.Created,
    observedAt: OBSERVED_AT,
  };
}

function seedRepositoryAuthority(organizationId: string): Promise<unknown> {
  return withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-${organizationId}`,
          fullName: REPO_FULL_NAME,
        }),
        owner: "acme",
        name: "web",
        htmlUrl: `https://github.com/${REPO_FULL_NAME}`,
      },
      select: { id: true },
    })
  );
}

/**
 * This session's PR evidence edges, counted through the PRODUCTION predicate
 * (`sessionPrLinkKindWhere`) rather than a hand-written `linkKind` filter, so
 * the assertion cannot drift from what the write lane actually persists.
 */
function countSessionPrLinks(
  organizationId: string,
  sessionArtifactId: string
): Promise<number> {
  return withDb((db) =>
    db.artifactLink.count({
      where: {
        organizationId,
        sourceId: sessionArtifactId,
        linkType: LinkType.RelatesTo,
        ...sessionPrLinkKindWhere(SessionPrLinkAudience.Evidence),
      },
    })
  );
}

describeIfDb("ISS-8604 session ingest create-arm race (real Postgres)", () => {
  beforeEach(() => {
    midSliceInterleave.run = null;
  });

  it("refuses to acknowledge a swept chunk sequence as a complete revision", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      // Chunk 0 stages `(42, total 3)` and chunk 1 advances the contiguous
      // count to 2. The FINAL chunk then arrives while a sweep takes the row —
      // and with it chunks 0 and 1's events. Read off the swept row the gate
      // saw `received 2 + this one >= 3`, committed `dataRevision: 42`, and
      // cleared the marker: a row holding ONE chunk, acknowledged as the
      // complete revision, which is the exact failure the chunk gate exists to
      // prevent and which nothing downstream can detect.
      const fixture = await importSession("sess-8604-chunk-ack", {
        ...buildSessionChunk({
          externalSessionId: "sess-8604-chunk-ack",
          name: SESSION_NAME,
          eventIds: ["evt-0"],
          chunk: { index: 0, total: 3 },
          dataRevision: CHUNK_REVISION,
        }),
        updatedAt: SEED_UPDATED_AT,
      });
      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: SESSION_NAME,
          eventIds: ["evt-1"],
          chunk: { index: 1, total: 3 },
          dataRevision: CHUNK_REVISION,
        }),
        updatedAt: SEED_UPDATED_AT,
      });
      const staged = await readPersistedChunkState(
        fixture.computeTargetId,
        fixture.externalSessionId
      );
      // The precondition, asserted rather than assumed: the marker really is
      // staged one chunk short of complete before the sweep.
      expect(staged).toMatchObject({
        dataRevision: null,
        pendingChunkRevision: CHUNK_REVISION,
        pendingChunkTotal: 3,
        pendingChunkReceived: 2,
      });

      midSliceInterleave.run = () => sweep(fixture.artifactId);
      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: SESSION_NAME,
          eventIds: ["evt-2"],
          chunk: { index: 2, total: 3 },
          dataRevision: CHUNK_REVISION,
        }),
        updatedAt: RESYNC_UPDATED_AT,
      });
      // Consumed, so the sweep really did land in the window.
      expect(midSliceInterleave.run).toBeNull();

      const persisted = await readPersistedChunkState(
        fixture.computeTargetId,
        fixture.externalSessionId
      );
      // The created row says exactly what it holds: one chunk's events, no
      // committed revision, and no sequence in flight. The desktop's next
      // chunk 0 re-stages and repairs it the ordinary way.
      expect(persisted).toEqual({
        eventIds: ["evt-2"],
        dataRevision: null,
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
      });
    });
  });

  it("ISS-10259: a swept sequence lands only the arriving slice, and the next full delivery clears and restores the tiling", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      // The tiling half of the case above, asked for by review (davetho, P1)
      // and pinned rather than argued. ISS-10259 lets the append lane write a
      // slice with nothing stored; on THIS path "nothing stored" is a fresh
      // artifact the sweep just forced, so the slice in hand is the only one
      // that ever reaches it.
      //
      // What the assertions below establish, in order: the stored tiling really
      // is as SHORT as the arriving chunk (not "short by a slice"); the session
      // is acked anyway, because `persisted` does not read the tiling lane — so
      // a refusal here could not have made the desktop re-prepare, and the
      // behaviour ISS-10259 changes on this path is which of two wrong tilings
      // is stored, not whether the sequence retries; and the next full delivery
      // CLEARS the stray slice and restores the whole tiling, so nothing is
      // permanently poisoned by the row this race leaves.
      const externalSessionId = "sess-8604-chunk-tiling";
      const fixture = await importSession(externalSessionId, {
        ...buildSessionChunk({
          externalSessionId,
          name: SESSION_NAME,
          eventIds: ["evt-0"],
          chunk: { index: 0, total: 3 },
          dataRevision: CHUNK_REVISION,
          // The clear `createChunkBuilders.baseFor` stamps on the events chunk
          // of a PAGINATED tiling. Explicit `[]`, never an absent key.
          activitySegmentRows: [],
        }),
        updatedAt: SEED_UPDATED_AT,
      });
      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId,
          name: SESSION_NAME,
          eventIds: ["evt-1"],
          chunk: { index: 1, total: 3 },
          dataRevision: CHUNK_REVISION,
          activitySegmentRows: [tilingSlice(1)],
        }),
        updatedAt: SEED_UPDATED_AT,
      });
      // The precondition: slice 1 appended against an EMPTY stored tiling, which
      // is the whole of ISS-10259 and is what makes the sweep below interesting.
      expect(
        await readPersistedTilingStartsMs(
          fixture.computeTargetId,
          externalSessionId
        )
      ).toEqual([SLICE_START_MS * 1]);

      midSliceInterleave.run = () => sweep(fixture.artifactId);
      const acked = await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId,
          name: SESSION_NAME,
          eventIds: ["evt-2"],
          chunk: { index: 2, total: 3 },
          dataRevision: CHUNK_REVISION,
          activitySegmentRows: [tilingSlice(2)],
        }),
        updatedAt: RESYNC_UPDATED_AT,
      });
      expect(midSliceInterleave.run).toBeNull();

      // Acked, so the outbox row clears. The tiling lane cannot change this —
      // it is what makes "refuse the slice so the desktop retries from chunk 0"
      // unreachable from here, and ISS-8604's ack contract the place to change it.
      expect(acked).toEqual([externalSessionId]);
      expect(
        await readPersistedChunkState(
          fixture.computeTargetId,
          externalSessionId
        )
      ).toEqual({
        eventIds: ["evt-2"],
        dataRevision: null,
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
      });
      // Only the arriving slice — slice 1 went with the swept artifact.
      expect(
        await readPersistedTilingStartsMs(
          fixture.computeTargetId,
          externalSessionId
        )
      ).toEqual([SLICE_START_MS * 2]);

      // The repair: the next delivery advances the revision, so its chunk 0
      // opens the sequence and its explicit-empty slice CLEARS the stray one
      // before the real slices re-append.
      //
      // Its spans are DISJOINT from the stray's (a re-derive re-tiles), which is
      // what makes the clear observable: re-sending the same `startMs` would
      // collide on the unique key under `skipDuplicates` and read identically
      // whether the clear ran or not.
      const repairSlices = [3, 4];
      for (const chunk of [0, 1, 2]) {
        await reimport(fixture, {
          ...buildSessionChunk({
            externalSessionId,
            name: SESSION_NAME,
            eventIds: [`evt-${chunk}`],
            chunk: { index: chunk, total: 3 },
            dataRevision: CHUNK_REVISION + 1,
            activitySegmentRows:
              chunk === 0 ? [] : [tilingSlice(repairSlices[chunk - 1])],
          }),
          updatedAt: REPAIR_UPDATED_AT,
        });
      }
      expect(
        await readPersistedTilingStartsMs(
          fixture.computeTargetId,
          externalSessionId
        )
      ).toEqual(repairSlices.map((slice) => SLICE_START_MS * slice));
      expect(
        await readPersistedChunkState(
          fixture.computeTargetId,
          externalSessionId
        )
      ).toMatchObject({
        eventIds: ["evt-0", "evt-1", "evt-2"],
        dataRevision: CHUNK_REVISION + 1,
        pendingChunkRevision: null,
      });
    });
  });

  it("gives a row created in the race its own status, anchor, roster and slug", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-8604-detail", {
        ...buildSessionChunk({
          externalSessionId: "sess-8604-detail",
          name: SESSION_NAME,
          eventIds: ["evt-0"],
        }),
        status: LEGACY_WAITING_WIRE_STATUS,
        awaitingInputSince: SWEPT_ANCHOR.toISOString(),
        agents: [buildAgent(SWEPT_AGENT_ID)],
        endedAt: SEED_UPDATED_AT,
        updatedAt: SEED_UPDATED_AT,
      });
      // Terminal, so `resolveGuardedStatus` would resolve the swept row's
      // status and the shared `detailData` would null the anchor off it.
      await withDb((db) =>
        db.artifact.update({
          where: { id: fixture.artifactId },
          data: { status: SESSION_STATUS.INACTIVE },
        })
      );

      midSliceInterleave.run = () => sweep(fixture.artifactId);
      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: SESSION_NAME,
          eventIds: ["evt-1"],
        }),
        status: LEGACY_WAITING_WIRE_STATUS,
        startedAt: PAYLOAD_STARTED_AT,
        agents: [buildAgent(PAYLOAD_AGENT_ID)],
        updatedAt: RESYNC_UPDATED_AT,
      });
      expect(midSliceInterleave.run).toBeNull();

      const persisted = await readSessionDetail(
        fixture.computeTargetId,
        fixture.externalSessionId
      );
      // A row Postgres created, so nothing on it may come off the swept one.
      expect(persisted.artifactId).not.toBe(fixture.artifactId);
      expect(persisted.artifact.status).toBe(SESSION_STATUS.ACTIVE);
      // The SYNTHESIZED tier — what a first delivery is entitled to — not the
      // swept row's anchor, and not the null terminal-wins would have written.
      expect(persisted.awaitingInputSince).toEqual(
        new Date(PAYLOAD_STARTED_AT)
      );
      expect(
        (persisted.agents as { externalAgentId: string }[]).map(
          (agent) => agent.externalAgentId
        )
      ).toEqual([PAYLOAD_AGENT_ID]);
      expect(persisted.agentCount).toBe(1);
      // Minted after the fact, because the pre-upsert read said a slug already
      // existed. Without it the row is unaddressable by slug forever: the update
      // arm never writes the column, so no later sync repairs it.
      expect(persisted.artifact.slug).toEqual(
        expect.stringMatching(SESSION_SLUG_PATTERN)
      );
    });
  });

  it("links a row created in the race to its own PRs despite a stale watermark", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-8604-pr-links");
      await seedRepositoryAuthority(fixture.organizationId);
      // Push the stored watermark AHEAD of the racing payload, so every PR lane
      // resolves STALE against the row that is about to be swept.
      await withDb((db) =>
        db.sessionDetail.update({
          where: { artifactId: fixture.artifactId },
          data: { sessionUpdatedAt: new Date(STORED_UPDATED_AT) },
          // The primary key, not the default projection. An unnarrowed write
          // fetches every scalar including `state`, which would enrol this file
          // in `DEFAULT_PROJECTION_POPULATION` — the ISS-7019 rollback surface a
          // human has to walk per release (removal-gate condition 2 in
          // docs/session-status-vocabulary.md). The result is discarded here, so
          // naming the key costs nothing and keeps that surface from growing.
          select: { artifactId: true },
        })
      );

      midSliceInterleave.run = () => sweep(fixture.artifactId);
      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: SESSION_NAME,
          eventIds: ["evt-1"],
        }),
        updatedAt: RESYNC_UPDATED_AT,
        artifactRefs: [pullRequestRef()],
        prRefs: [
          {
            repositoryFullName: REPO_FULL_NAME,
            prNumber: PR_NUMBER,
            relationType: SessionPrRelationType.Created,
          },
        ],
        prs: [{ num: PR_NUMBER, title: `PR ${PR_NUMBER}`, status: "open" }],
      });
      expect(midSliceInterleave.run).toBeNull();

      const persisted = await readSessionDetail(
        fixture.computeTargetId,
        fixture.externalSessionId
      );
      expect(persisted.artifactId).not.toBe(fixture.artifactId);
      // The gate opens on a row that does not exist, because there is no newer
      // canonical set to protect. Gated on the swept row's watermark instead,
      // the acknowledged session carried no PR association at all — and an
      // ended session's frozen `updatedAt` means no later batch relitigates it.
      expect(
        await countSessionPrLinks(fixture.organizationId, persisted.artifactId)
      ).toBe(1);
      // The blob half of the same correction, so the two PR surfaces agree.
      expect(persisted.pullRequests).not.toBeNull();
    });
  });

  it("does not reinstate a swept row's withheld metadata onto the created row", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      // `resolveDegradedMetadataPersist` reinstates the top-level keys a payload
      // DECLARES it withheld from the blob "sitting in the row the upsert is
      // about to overwrite". In the race there is no such row — but its read is
      // issued because the pre-upsert `existing` was non-null, and it lands in
      // the same window, so it hands back the doomed row's blob. Unfixed, the
      // create arm republished `usageExtras` onto a brand-new artifact,
      // resurrecting on the new row exactly what retention had just deleted.
      const fixture = await importSession("sess-8604-metadata", {
        ...buildSessionChunk({
          externalSessionId: "sess-8604-metadata",
          name: SESSION_NAME,
          eventIds: ["evt-0"],
        }),
        metadata: { [WITHHELD_KEY]: SWEPT_WITHHELD_VALUE, keep: "seeded" },
        updatedAt: SEED_UPDATED_AT,
      });
      const seeded = await readSessionDetail(
        fixture.computeTargetId,
        fixture.externalSessionId
      );
      // The precondition, asserted rather than assumed: the key really is on the
      // row the sweep is about to take, so its absence below means something.
      expect(seeded.metadata).toMatchObject({
        [WITHHELD_KEY]: SWEPT_WITHHELD_VALUE,
      });

      // The seam runs the real resolver and THEN the hook, so the merge's own
      // read sees the row and the sweep commits behind it — the leaking window.
      midSliceInterleave.run = () => sweep(fixture.artifactId);
      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: SESSION_NAME,
          eventIds: ["evt-1"],
        }),
        metadata: { keep: "resynced" },
        metadataWithheldKeys: [WITHHELD_KEY],
        updatedAt: RESYNC_UPDATED_AT,
      });
      expect(midSliceInterleave.run).toBeNull();

      const persisted = await readSessionDetail(
        fixture.computeTargetId,
        fixture.externalSessionId
      );
      expect(persisted.artifactId).not.toBe(fixture.artifactId);
      // The payload's own blob, verbatim: the key it could not carry stays gone
      // on a row that never held it.
      expect(persisted.metadata).toEqual({ keep: "resynced" });
    });
  });

  it("leaves the ordinary update arm alone when no sweep interleaves", async () => {
    // The positive control for all three cases above: without it, a slice that
    // took the create arm on EVERY resync would satisfy them just as well.
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-8604-no-race", {
        ...buildSessionChunk({
          externalSessionId: "sess-8604-no-race",
          name: SESSION_NAME,
          eventIds: ["evt-0"],
        }),
        agents: [buildAgent(SWEPT_AGENT_ID)],
        updatedAt: SEED_UPDATED_AT,
      });

      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: SESSION_NAME,
          eventIds: ["evt-1"],
        }),
        agents: [buildAgent(PAYLOAD_AGENT_ID)],
        updatedAt: RESYNC_UPDATED_AT,
      });

      const persisted = await readSessionDetail(
        fixture.computeTargetId,
        fixture.externalSessionId
      );
      expect(persisted.artifactId).toBe(fixture.artifactId);
      // The update arm still MERGES, so an additive delivery cannot drop an
      // agent it did not carry.
      expect(
        (persisted.agents as { externalAgentId: string }[]).map(
          (agent) => agent.externalAgentId
        )
      ).toEqual([SWEPT_AGENT_ID, PAYLOAD_AGENT_ID]);
      expect(persisted.agentCount).toBe(2);
    });
  });
});

/**
 * ISS-10259: the span chunk N of a paginated tiling carries. One row per chunk,
 * so `startMs` names the chunk it rode and a read-back says which slices landed.
 */
const SLICE_START_MS = 1000;

/** Strictly NEWER than every delivery above, so the repair reads as fresh. */
const REPAIR_UPDATED_AT = "2026-06-10T13:00:00.000Z";

function tilingSlice(chunkIndex: number): Record<string, unknown> {
  const startMs = SLICE_START_MS * chunkIndex;
  return {
    phase: "implement",
    startMs,
    endMs: startMs + 999,
    confidence: 0.9,
    evidenceLayers: ["structural"],
    version: 7,
  };
}
