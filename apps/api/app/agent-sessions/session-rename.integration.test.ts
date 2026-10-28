/**
 * ISS-8717 — a session rename must survive the collector.
 *
 * The defect this suite exists to catch is not "the write did not land"; it is
 * "the write landed and the next sync erased it". So every rename here is
 * followed by a REAL re-import — `parseDesktopAgentSessionsPayload` +
 * `agentSessionsService.upsertSessions`, the same two calls the desktop sync
 * route makes — and the name is read back through the production detail read
 * rather than off the column, so the assertion covers the projection too.
 */
import { randomUUID } from "node:crypto";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditReceiptResult,
  ArtifactFieldEditValueClassification,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { DocumentStatus } from "@repo/api/src/types/document";
import { Status } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSessionChunk,
  createComputeTarget,
  ingestChunk,
} from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";
import {
  agentSessionProjection,
  searchIndexService,
} from "@/app/search/search-index-service";
import { agentSessionsService } from "./service";
import { sessionRenameService } from "./session-rename-service";

// The rename's search-projection refresh is scheduled through `waitUntil`, so a
// test has no handle on it otherwise. Capturing the promise — rather than
// sleeping, or asserting on a mocked `searchIndexService` — leaves the whole
// production path intact (rename service → `updateTitleAfterCommit` →
// `runBestEffort` → the real SQL) and stubs only the platform's fire-and-forget
// scheduler, which is the one thing a test cannot await.
const scheduled = vi.hoisted((): Promise<unknown>[] => []);
vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    scheduled.push(work);
  },
}));

/**
 * A seam INSIDE `upsertSessionSlice`, between its pre-upsert `existing` read and
 * the upsert itself — the window a rename can commit in, since
 * `sessionRenameService` takes none of that transaction's advisory locks.
 * `resolveDegradedMetadataPersist` is awaited in exactly that window and is
 * otherwise inert here (these payloads declare no withheld keys), so arming this
 * orders the two writers deterministically instead of racing two connections.
 *
 * Unarmed it is a pass-through, so every other test in this file is unaffected.
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

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const COLLECTED_NAME = "fix/collector-derived-title";
/** Stands in for the indexed transcript text a rename must not disturb. */
const TRANSCRIPT_BODY = "assistant: rewrote the ledger writer";
const IMPOSTOR_TIMESTAMP = new Date("2026-09-01T00:00:00.000Z");
const REDERIVED_NAME = "fix/collector-rederived-title";
const OWNER_CHOSEN_NAME = "Ledger rewrite, take two";
const ADMIN_CHOSEN_NAME = "Renamed by an org admin";
const INDEX_FAILURE_MESSAGE = "search_document is unreachable";
/** What a desktop payload predating the cloud rename would still carry. */
const STALE_DESKTOP_OVERRIDE = "Ledger rewrite, take one";

type Fixture = {
  organizationId: string;
  ownerId: string;
  computeTargetId: string;
  externalSessionId: string;
  artifactId: string;
};

/** Import one session the way the desktop does, and resolve its cloud ids. */
async function importSession(externalSessionId: string): Promise<Fixture> {
  const organizationId = await createTestOrganization();
  const owner = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    owner.id,
    "lane-8717"
  );
  const context = { organizationId, userId: owner.id, computeTargetId };
  await ingestChunk(
    context,
    randomUUID(),
    buildSessionChunk({
      externalSessionId,
      name: COLLECTED_NAME,
      eventIds: ["evt-0"],
    })
  );
  const detail = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifactId: true },
    })
  );
  return {
    organizationId,
    ownerId: owner.id,
    computeTargetId,
    externalSessionId,
    artifactId: detail.artifactId,
  };
}

/** Re-run the collector over the same session, deriving a fresh placeholder. */
function reimport(
  fixture: Fixture,
  session: Record<string, unknown>
): Promise<string[]> {
  return ingestChunk(
    {
      organizationId: fixture.organizationId,
      userId: fixture.ownerId,
      computeTargetId: fixture.computeTargetId,
    },
    randomUUID(),
    session
  );
}

/** The name the production read serves — list and detail share this projection. */
async function readServedName(
  fixture: Fixture
): Promise<string | null | undefined> {
  const detail = await agentSessionsService.findSessionDetail({
    id: fixture.artifactId,
    organizationId: fixture.organizationId,
  });
  return detail?.name;
}

function readStoredArtifactName(artifactId: string): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { name: true },
    });
    return artifact.name;
  });
}

/** Drain the `waitUntil` queue so post-commit work is observable, not raced. */
async function settleScheduledWork(): Promise<void> {
  await Promise.all(scheduled.splice(0, scheduled.length));
}

/**
 * Put this session in the unified-search projection the way production does —
 * through the same `agentSessionProjection` + `searchIndexService.upsert` the
 * transcript indexer calls — so the rename is tested against a real row rather
 * than one hand-shaped by the test.
 */
async function projectSessionIntoSearch(
  fixture: Fixture,
  title: string
): Promise<void> {
  await searchIndexService.upsert(
    agentSessionProjection({
      artifactId: fixture.artifactId,
      organizationId: fixture.organizationId,
      title,
      body: TRANSCRIPT_BODY,
      userId: fixture.ownerId,
      priority: null,
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    })
  );
}

function readSearchProjection(
  fixture: Fixture
): Promise<{ title: string; body: string | null }[]> {
  return withDb(
    (db) =>
      db.$queryRaw`
      SELECT "title", "body"
      FROM "search_document"
      WHERE "organization_id" = ${fixture.organizationId}::uuid
        AND "entity_type" = ${SearchEntityType.AgentSession}
        AND "entity_id" = ${fixture.artifactId}::uuid
    `
  );
}

describeIfDb("ISS-8717 session rename write path", () => {
  beforeEach(() => {
    scheduled.length = 0;
    midSliceInterleave.run = null;
    // The fail-open case spies on the real `searchIndexService`; without this
    // its rejecting stub leaks into every later test in this file.
    vi.restoreAllMocks();
  });

  it("records only the committed name transition with its real actor", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-name-activity");
      const first = await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });
      const retry = await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });

      expect(first.ok).toBe(true);
      expect(retry.ok).toBe(true);
      const rows = await withDb((db) =>
        db.artifactActivityEvent.findMany({
          where: {
            organizationId: fixture.organizationId,
            artifactId: fixture.artifactId,
            action: ArtifactActivityAction.FieldChange,
          },
          select: { actorType: true, actorId: true, before: true, after: true },
        })
      );
      expect(rows).toEqual([
        {
          actorType: ArtifactActivityActorType.User,
          actorId: fixture.ownerId,
          before: {
            field: ArtifactFieldEditField.Name,
            value: COLLECTED_NAME,
            valueClassification: ArtifactFieldEditValueClassification.Content,
          },
          after: {
            field: ArtifactFieldEditField.Name,
            value: OWNER_CHOSEN_NAME,
            valueClassification: ArtifactFieldEditValueClassification.Content,
            result: ArtifactFieldEditReceiptResult.Committed,
          },
        },
      ]);
    });
  });

  it("still serves the rename after the collector re-imports the session", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-survives-reimport");

      const renamed = await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });
      expect(renamed.ok).toBe(true);

      // The whole point: a full re-import that re-derives a DIFFERENT
      // placeholder. Before the override existed this call is what reverted the
      // rename, so a test that stops before it proves nothing.
      await reimport(
        fixture,
        buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: REDERIVED_NAME,
          eventIds: ["evt-0", "evt-1"],
        })
      );

      expect(await readServedName(fixture)).toBe(OWNER_CHOSEN_NAME);
    });
  });

  it("keeps the collector's placeholder recoverable behind the rename", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-placeholder-recoverable");
      await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });
      await reimport(
        fixture,
        buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: REDERIVED_NAME,
          eventIds: ["evt-0", "evt-1"],
        })
      );

      // The rename did not consume the collector's channel: `artifacts.name`
      // still tracks the newest derivation, so the placeholder is recoverable
      // for a renamed session and not merely for an untouched one.
      expect(await readStoredArtifactName(fixture.artifactId)).toBe(
        REDERIVED_NAME
      );
      expect(await readServedName(fixture)).toBe(OWNER_CHOSEN_NAME);
    });
  });

  it("refuses a non-owner in the same organization who can read the session", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-non-owner-refused");
      const colleague = await createTestUser(fixture.organizationId);

      // Pin that the colleague really can READ it — otherwise a refusal proves
      // only that the session was unreachable, not that ownership was enforced.
      const readable = await agentSessionsService.findSessionDetail({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
      });
      expect(readable?.id).toBe(fixture.artifactId);

      const result = await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: colleague.id,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: "Not mine to rename",
      });

      expect(result).toEqual({ ok: false, error: Status.Forbidden });
      expect(await readServedName(fixture)).toBe(COLLECTED_NAME);
    });
  });

  // ISS-8733 widened the rename from OWNER-only to OWNER-or-ORG-ADMIN. The
  // counterfactual is inside the test on purpose: the same caller, the same
  // fixture, differing only in the flag. Asserting the success arm alone would
  // still pass against a predicate that had dropped ownership entirely and
  // admitted every org member, which is exactly the regression to catch.
  it("admits an org admin who is NOT the owner, and refuses that same caller without the role", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-admin-not-owner");
      const admin = await createTestUser(fixture.organizationId);
      // Load-bearing: an "admin" who is also the owner would pass on the
      // owner-only predicate this test exists to disprove.
      expect(admin.id).not.toBe(fixture.ownerId);

      const withoutRole = await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: admin.id,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: ADMIN_CHOSEN_NAME,
      });
      expect(withoutRole).toEqual({ ok: false, error: Status.Forbidden });
      expect(await readServedName(fixture)).toBe(COLLECTED_NAME);

      const withRole = await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: admin.id,
        authMethod: "session",
        actorIsOrgAdmin: true,
        name: ADMIN_CHOSEN_NAME,
      });
      expect(withRole.ok).toBe(true);
      expect(await readServedName(fixture)).toBe(ADMIN_CHOSEN_NAME);
    });
  });

  // The admin arm drops the OWNERSHIP narrowing and nothing else. These two pin
  // the other halves of the predicate against a widening that reached too far.
  it("does not let an org admin reach a session in another organization", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-admin-cross-org");
      const otherOrganizationId = await createTestOrganization();
      const foreignAdmin = await createTestUser(otherOrganizationId);

      const result = await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: otherOrganizationId,
        actorUserId: foreignAdmin.id,
        authMethod: "session",
        actorIsOrgAdmin: true,
        name: "Not my org",
      });

      expect(result).toEqual({ ok: false, error: Status.NotFound });
      expect(await readServedName(fixture)).toBe(COLLECTED_NAME);
    });
  });

  it("does not let an org admin rename a non-session artifact through this endpoint", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-admin-type-scoped");
      const admin = await createTestUser(fixture.organizationId);
      const impostorId = await createNonSessionArtifactWithDetail(fixture);

      const result = await sessionRenameService.rename({
        id: impostorId,
        organizationId: fixture.organizationId,
        actorUserId: admin.id,
        authMethod: "session",
        actorIsOrgAdmin: true,
        name: "Renamed through the Sessions endpoint",
      });

      expect(result).toEqual({ ok: false, error: Status.NotFound });
      const stored = await withDb((db) =>
        db.sessionDetail.findUniqueOrThrow({
          where: { artifactId: impostorId },
          select: { nameOverride: true },
        })
      );
      expect(stored.nameOverride).toBeNull();
    });
  });

  // ISS-8733 review (bug-hunter-a): the id is an unvalidated ROUTE SEGMENT, and
  // `session_detail.artifact_id` is `@db.Uuid`. Before the guard, a non-uuid
  // path segment reached the query engine and surfaced as a 500 — an input error
  // reported as a server fault. Exercised against a real database because the
  // failure mode was the driver raising, which a mocked client cannot reproduce.
  it("refuses a malformed session id as NotFound instead of raising", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-malformed-id");

      const result = await sessionRenameService.rename({
        id: "not-a-uuid",
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });

      expect(result).toEqual({ ok: false, error: Status.NotFound });
    });
  });

  it("refuses a session id from another organization", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-cross-org-refused");
      const otherOrganizationId = await createTestOrganization();
      const outsider = await createTestUser(otherOrganizationId);

      const result = await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: otherOrganizationId,
        actorUserId: outsider.id,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: "Not my org",
      });

      // NotFound, not Forbidden: a cross-org id must not confirm that the
      // session exists.
      expect(result).toEqual({ ok: false, error: Status.NotFound });
      expect(await readServedName(fixture)).toBe(COLLECTED_NAME);
    });
  });

  it("accepts an older desktop payload that omits nameOverride and changes nothing", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-old-desktop-payload");
      await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });

      // `buildSessionChunk` emits no `nameOverride` key at all — the exact wire
      // shape of a desktop build that predates this column.
      const payload = buildSessionChunk({
        externalSessionId: fixture.externalSessionId,
        name: REDERIVED_NAME,
        eventIds: ["evt-0", "evt-1"],
      });
      expect(Object.hasOwn(payload, "nameOverride")).toBe(false);

      const persistedIds = await reimport(fixture, payload);

      // Accepted, not rejected...
      expect(persistedIds).toContain(fixture.externalSessionId);
      // ...and inert with respect to the override.
      expect(await readServedName(fixture)).toBe(OWNER_CHOSEN_NAME);
    });
  });

  it("does NOT let an explicit null override clear a rename", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-explicit-null-override");
      await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });

      // A DISTINCT wire state from omission: the schema accepts an explicit
      // `null` here, so a client that sends one reaches the ingest guard with a
      // present-but-null field. Absent coverage of it, narrowing the guard from
      // truthiness to `!== undefined` passes every other case in this file and
      // silently erases the rename on the next sync.
      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: REDERIVED_NAME,
          eventIds: ["evt-0", "evt-1"],
        }),
        nameOverride: null,
      });

      expect(await readServedName(fixture)).toBe(OWNER_CHOSEN_NAME);
    });
  });

  // ISS-8732 (decision, Marisol 2026-09-01): cloud-authoritative naming — desktop
  // sync must not overwrite `session_detail.name_override`. The conflict case
  // davetho raised on PR #6367, driven end to end: the two siblings above
  // replay a payload that OMITS the field and one that sends explicit `null`,
  // and both stay green against an ingest that overwrites on a non-null value.
  // Only a stale payload carrying a DIFFERENT override exercises the rule.
  it("does not let a stale desktop payload carrying its own override beat the cloud rename", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-stale-override-conflict");
      await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });

      // A redelivery of the batch the rename raced. The rename deliberately does
      // not move `sessionUpdatedAt`, so this arrives at an EQUAL watermark and
      // the freshness gate admits it — the override must be withheld by the
      // precedence rule itself, not by staleness.
      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: REDERIVED_NAME,
          eventIds: ["evt-0", "evt-1"],
        }),
        nameOverride: STALE_DESKTOP_OVERRIDE,
      });

      expect(await readServedName(fixture)).toBe(OWNER_CHOSEN_NAME);
      const stored = await withDb((db) =>
        db.sessionDetail.findUniqueOrThrow({
          where: { artifactId: fixture.artifactId },
          select: { nameOverride: true },
        })
      );
      expect(stored.nameOverride).toBe(OWNER_CHOSEN_NAME);
    });
  });

  // ISS-8732 (review: davetho, PR #6618). The sibling above replays a stale
  // payload AFTER the rename has committed, which the pre-upsert read alone
  // already refused. This one puts the rename INSIDE the slice's read→write
  // window — the interleaving that read cannot see — so it fails against a seed
  // computed from `existing` and passes only because the write itself carries
  // `nameOverride: null`.
  //
  // What it pins is the ORDERING, on one connection: the rename is committed
  // before the slice writes. It deliberately does not model lock contention,
  // which is the other half the predicate covers and which no deterministic test
  // can hold still. `carries a desktop-authored override onto a session that has
  // none`, below, is the positive control on the same write — without it a seed
  // that never fires at all would satisfy this assertion.
  it("does not let a sync seed undo a rename that commits inside its read-write window", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-rename-inside-slice-window");

      midSliceInterleave.run = async () => {
        const renamed = await sessionRenameService.rename({
          id: fixture.artifactId,
          organizationId: fixture.organizationId,
          actorUserId: fixture.ownerId,
          authMethod: "session",
          actorIsOrgAdmin: false,
          name: OWNER_CHOSEN_NAME,
        });
        expect(renamed.ok).toBe(true);
      };

      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: REDERIVED_NAME,
          eventIds: ["evt-0", "evt-1"],
        }),
        nameOverride: STALE_DESKTOP_OVERRIDE,
      });

      // Consumed, so the rename really did land in the window rather than the
      // assertions below passing on a slice that never reached the seam.
      expect(midSliceInterleave.run).toBeNull();
      expect(await readServedName(fixture)).toBe(OWNER_CHOSEN_NAME);
      const stored = await withDb((db) =>
        db.sessionDetail.findUniqueOrThrow({
          where: { artifactId: fixture.artifactId },
          select: { nameOverride: true },
        })
      );
      expect(stored.nameOverride).toBe(OWNER_CHOSEN_NAME);
    });
  });

  it("carries a desktop-authored override onto a session that has none", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-desktop-authored-override");
      expect(await readServedName(fixture)).toBe(COLLECTED_NAME);

      await reimport(fixture, {
        ...buildSessionChunk({
          externalSessionId: fixture.externalSessionId,
          name: REDERIVED_NAME,
          eventIds: ["evt-0", "evt-1"],
        }),
        nameOverride: OWNER_CHOSEN_NAME,
      });

      expect(await readServedName(fixture)).toBe(OWNER_CHOSEN_NAME);
    });
  });

  // ISS-8717 review (whitlockk, and the same finding from the codex reviewer): the
  // search projection materializes the session TITLE into its own row and is
  // refreshed only when a transcript is archived or finalized. A session renamed
  // after its transcript landed therefore stayed searchable — and displayed in
  // global search results — under the collector's placeholder indefinitely,
  // contradicting the Sessions surface the rename was made on.
  it("retitles the already-indexed search projection so search cannot keep serving the placeholder", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-search-retitled");
      await projectSessionIntoSearch(fixture, COLLECTED_NAME);

      await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });
      await settleScheduledWork();

      // The title moved, and the indexed transcript body — which this write path
      // cannot re-derive without an S3 read — is untouched. Asserting the body
      // is the half that catches a "fix" that upserts a blank row over a good
      // one, which would silently make the session's transcript unsearchable.
      expect(await readSearchProjection(fixture)).toEqual([
        { title: OWNER_CHOSEN_NAME, body: TRANSCRIPT_BODY },
      ]);
    });
  });

  it("does not project a never-indexed session into search on rename", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-search-not-projected");
      expect(await readSearchProjection(fixture)).toEqual([]);

      await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });
      await settleScheduledWork();

      // UPDATE, never upsert. A session is projected only for an org that opted
      // into transcript search, so a rename that INSERTED here would index a
      // session for an org that never opted in — a privacy regression wearing a
      // consistency fix's clothes.
      expect(await readSearchProjection(fixture)).toEqual([]);
    });
  });

  // ISS-8731 (decision, Marisol 2026-09-01): the retitle is BEST-EFFORT and a
  // failure must not fail the rename. Narrowing `updateTitleAfterCommit` to an
  // awaited `updateTitle` turns a projection outage into a 500 on a user's
  // rename, and no other test in this file goes red for it.
  //
  // WHAT ACTUALLY REPAIRS THE STALE TITLE (review: whitlockk). Not session ingest —
  // `upsertSessionSlice` never touches `search_document`. The only writers are
  // `POST /desktop/transcripts/complete`, which re-projects the row when a
  // transcript upload finalizes, and the `backfill-transcript-search` script. So
  // a session whose transcript has already landed keeps answering search under
  // the stale title until one of those two runs.
  it("commits the rename when the search retitle fails, leaving the stale title for a later transcript finalize", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-search-retitle-fails");
      await projectSessionIntoSearch(fixture, COLLECTED_NAME);

      const retitle = vi
        .spyOn(searchIndexService, "updateTitle")
        .mockRejectedValue(new Error(INDEX_FAILURE_MESSAGE));

      const renamed = await sessionRenameService.rename({
        id: fixture.artifactId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: OWNER_CHOSEN_NAME,
      });
      // Settles rather than rejects: an unhandled rejection would take the
      // invocation down after the response had already been sent.
      await expect(settleScheduledWork()).resolves.toBeUndefined();

      // Reached the index seam, so a rename that stopped enqueuing cannot pass.
      expect(retitle).toHaveBeenCalledTimes(1);
      expect(retitle).toHaveBeenCalledWith(
        {
          organizationId: fixture.organizationId,
          entityType: SearchEntityType.AgentSession,
          entityId: fixture.artifactId,
        },
        OWNER_CHOSEN_NAME
      );

      expect(renamed.ok).toBe(true);
      expect(await readServedName(fixture)).toBe(OWNER_CHOSEN_NAME);

      // The injected failure was real. The sibling test above pins this same row
      // in the opposite state, which is what separates "fail-open" from "the
      // retitle never ran".
      expect(await readSearchProjection(fixture)).toEqual([
        { title: COLLECTED_NAME, body: TRANSCRIPT_BODY },
      ]);
    });
  });

  // ISS-8648 (PR #6330) established that `session_detail.artifact_id` is a plain
  // FK with no constraint on the parent artifact's TYPE, so every Sessions write
  // must carry `type` in its predicate. Same hole, same endpoint family.
  it("refuses a non-session artifact that carries a detail row", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession("sess-type-scoped");
      const impostorId = await createNonSessionArtifactWithDetail(fixture);

      const result = await sessionRenameService.rename({
        id: impostorId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.ownerId,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: "Renamed through the Sessions endpoint",
      });

      // NotFound rather than Forbidden: the classifying read is type-scoped too,
      // so a non-session id is not confirmed to exist as a session either.
      expect(result).toEqual({ ok: false, error: Status.NotFound });
      const stored = await withDb((db) =>
        db.sessionDetail.findUniqueOrThrow({
          where: { artifactId: impostorId },
          select: { nameOverride: true },
        })
      );
      expect(stored.nameOverride).toBeNull();
    });
  });
});

/**
 * A DOCUMENT artifact carrying a `session_detail` row, owned by the same user in
 * the same org — the shape the FK permits and no production path produces. It
 * exists only so the `type` filter in the rename predicate is provably doing
 * something; without it this row is indistinguishable from a session.
 */
function createNonSessionArtifactWithDetail(fixture: Fixture): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId: fixture.organizationId,
        type: ArtifactType.DOCUMENT,
        name: "Not a session",
        status: DocumentStatus.Draft,
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: artifact.id,
        computeTargetId: fixture.computeTargetId,
        externalSessionId: `impostor-${randomUUID()}`,
        sessionStartedAt: IMPOSTOR_TIMESTAMP,
        sessionUpdatedAt: IMPOSTOR_TIMESTAMP,
        lastActivityAt: IMPOSTOR_TIMESTAMP,
      },
      select: { artifactId: true },
    });
    return artifact.id;
  });
}
