import { randomUUID } from "node:crypto";
import { AgentComponentInvocationSyncAckState } from "@repo/api/src/types/agent-component-invocation";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPart,
  EXTERNAL_SESSION_ID,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import { observeStatements } from "@/__tests__/support/db-statement-observer";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentComponentInvocationsService } from "../component-invocations";
import { persistArtifactLinks } from "./slug-links";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();
afterEach(() => organizations.cleanup());

describeIfDb("slug batch concurrency in PostgreSQL", () => {
  it("keeps invocation generation serialized behind the session row through the 54-ref replay", async () => {
    const fixture = await seed();
    const locked = deferred<number>();
    const release = deferred<void>();
    let holderMs = 0;
    const holder = withDb.tx(async (tx) => {
      await tx.sessionDetail.update({
        where: { artifactId: fixture.sourceId },
        data: { metadata: { sync: true } },
        select: { artifactId: true },
      });
      const [backend] = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      locked.resolve(backend.pid);
      await release.promise;
      const started = performance.now();
      await persistArtifactLinks(
        tx,
        fixture.organizationId,
        fixture.sourceId,
        fixture.refs,
        fixture.slugMap,
        fixture.at
      );
      holderMs = performance.now() - started;
    });
    const pid = await locked.promise;
    const invocationStarted = performance.now();
    const invocation = agentComponentInvocationsService.ingestPart({
      organizationId: fixture.organizationId,
      computeTargetId: fixture.computeTargetId,
      part: buildPart({ allItems: [] }),
    });
    let blocking:
      | {
          waitEventType: string;
          waitEvent: string;
          blocker: number;
          ageMs: number;
          mode: string;
          query: string;
        }
      | undefined;
    try {
      for (let attempt = 0; attempt < 200 && !blocking; attempt += 1) {
        [blocking] = await withDb(
          (db) => db.$queryRaw<(typeof blocking)[]>`
          SELECT waiter.wait_event_type AS "waitEventType", waiter.wait_event AS "waitEvent",
            waiter.query, waiting.mode, holder.pid AS blocker, EXTRACT(EPOCH FROM clock_timestamp() - holder.xact_start) * 1000 AS "ageMs"
          FROM pg_stat_activity waiter JOIN pg_stat_activity holder ON holder.pid = ANY(pg_blocking_pids(waiter.pid))
          JOIN pg_locks waiting ON waiting.pid = waiter.pid AND NOT waiting.granted
          WHERE holder.pid = ${pid} AND waiter.query LIKE '%session_detail%' AND waiter.query LIKE '%FOR UPDATE%'
        `
        );
      }
      expect(blocking?.blocker).toBe(pid);
      expect(blocking?.waitEventType).toBe("Lock");
      expect(blocking?.mode).toBe("ShareLock");
    } finally {
      release.resolve();
      await holder;
    }
    const result = await invocation;
    expect(result).toMatchObject({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    const generations = await withDb((db) =>
      db.agentComponentInvocationGeneration.findMany({
        where: { agentSessionId: fixture.sourceId },
      })
    );
    expect(generations).toHaveLength(1);
    expect(generations[0].activeAt).not.toBeNull();
    console.info("ISS-9278 controlled lock replay", {
      refs: 54,
      holderMs,
      invocationMs: performance.now() - invocationStarted,
      blocking,
    });
  });

  it("converges overlapping reversed ref batches and protects an existing lane's metadata", async () => {
    const fixture = await seed();
    const targets = [...fixture.slugMap.values()];
    await withDb((db) =>
      db.artifactLink.updateMany({
        where: {
          organizationId: fixture.organizationId,
          sourceId: fixture.sourceId,
        },
        data: {
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            keep: "evidence",
          },
          lastContributedAt: null,
        },
      })
    );
    const newer = "2026-09-18T17:00:00.000Z";
    const oldRefs = fixture.refs.map((ref) => ({
      ...ref,
      observedAt: "2026-09-17T10:00:00.000Z",
    }));
    const newRefs = fixture.refs
      .map((ref) => ({ ...ref, observedAt: newer }))
      .reverse();
    await Promise.all(
      [oldRefs, [...newRefs, newRefs[0]]].map((refs) =>
        withDb.tx((tx) =>
          persistArtifactLinks(
            tx,
            fixture.organizationId,
            fixture.sourceId,
            refs,
            fixture.slugMap,
            fixture.at
          )
        )
      )
    );
    await withDb.tx((tx) =>
      persistArtifactLinks(
        tx,
        fixture.organizationId,
        fixture.sourceId,
        fixture.refs.map(({ observedAt: _at, ...ref }) => ref),
        fixture.slugMap,
        new Date("2026-09-01T00:00:00Z")
      )
    );
    const rows = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId: fixture.organizationId,
          sourceId: fixture.sourceId,
        },
      })
    );
    expect(rows).toHaveLength(54);
    expect(new Set(rows.map((row) => row.targetId))).toEqual(new Set(targets));
    for (const row of rows) {
      expect(row.metadata).toEqual({
        linkKind: "session_branch",
        keep: "evidence",
      });
      expect(row.lastContributedAt?.toISOString()).toBe(newer);
    }
  });
});

async function seed() {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    "iss9278"
  );
  const at = new Date("2026-09-18T14:59:30.000Z");
  const source = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.Session,
        name: "Session",
        status: SESSION_STATUS.INACTIVE,
        session: {
          create: {
            computeTargetId,
            sessionStartedAt: at,
            sessionUpdatedAt: at,
            lastActivityAt: at,
            externalSessionId: EXTERNAL_SESSION_ID,
          },
        },
      },
    })
  );
  const refs = Array.from({ length: 54 }, (_, index) => ({
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: `ISS-${index + 1}`,
    method: ArtifactRefMethod.McpToolCall,
    isPrimary: false,
    observedAt: at.toISOString(),
  }));
  const slugMap = new Map(refs.map((ref) => [ref.slug, randomUUID()]));
  await withDb((db) =>
    db.artifact.createMany({
      data: [...slugMap.values()].map((id) => ({
        id,
        organizationId,
        type: ArtifactType.Document,
        name: id,
        status: "DRAFT",
      })),
    })
  );
  const { statements } = await observeStatements(() =>
    withDb.tx((tx) =>
      persistArtifactLinks(tx, organizationId, source.id, refs, slugMap, at)
    )
  );
  console.info("ISS-9278 slug create", { statements: statements.length });
  return {
    organizationId,
    computeTargetId,
    sourceId: source.id,
    refs,
    slugMap,
    at,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("uninitialized deferred");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
