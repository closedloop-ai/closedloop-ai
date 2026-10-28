/**
 * @file segment-work-item-stamp-coverage.test.ts
 * @description ISS-8730 coverage for `segment-work-item-stamp.ts`'s exported
 * `stampSegmentWorkItemRefs`. The PURE resolution logic it delegates to
 * (`resolveSegmentWorkItemRefs`) already has its own dedicated suite
 * (`segment-work-item-ref.test.ts`) covering precedence, occurrence scoping,
 * and the PR/branch fallback gate — this file does not re-derive that. It
 * instead pins the DB-facing half this module owns: the early-out on an
 * unsegmented session, the artifact-link query's kind/scope filter, the
 * guarded-vs-unguarded UPDATE shape (clearing to NULL vs. setting a value),
 * the "changed" count honesty (a same-value rewrite still writes but does not
 * count), and the id-chunking boundary at `EVENT_INSERT_PARAM_CAP`.
 *
 * `tx` is a hand-built fake implementing only the two delegates this module
 * calls (`sessionActivitySegment`, `sessionArtifactLink`), matching the
 * established fake-tx pattern in `artifact-link-backfill.test.ts`. It is not
 * a real Prisma client, so it is cast once at the call boundary rather than
 * typed in full.
 */
import assert from "node:assert/strict";
import { ACTIVITY_PHASE } from "@repo/api/src/types/activity-phase";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { describe, test } from "vitest";
import { EVENT_INSERT_PARAM_CAP } from "../src/main/database/db-constants.js";
import type { Prisma } from "../src/main/database/generated/client.js";
import { stampSegmentWorkItemRefs } from "../src/main/database/segment-work-item-stamp.js";

type FakeSegmentRow = {
  id: string;
  startMs: number | bigint;
  endMs: number | bigint;
  phase: string;
  workItemRef: string | null;
};

type FakeLinkRow = {
  relation: string;
  isPrimary: boolean;
  artifact: {
    slug: string | null;
    kind: string;
    prNumber: number | null;
    branchName: string | null;
    repoFullName: string | null;
  };
};

type UpdateManyCall = {
  where: {
    sessionId: string;
    id: { in: string[] };
    workItemRef?: { not: null };
  };
  data: { workItemRef: string | null };
};

type FindManyLinkArgs = {
  where: { sessionId: string; artifact: { kind: { in: string[] } } };
};

function segRow(
  id: string,
  startMs: number | bigint,
  endMs: number | bigint,
  phase: string,
  workItemRef: string | null
): FakeSegmentRow {
  return { id, startMs, endMs, phase, workItemRef };
}

function linkRow(opts: {
  slug: string | null;
  kind: ArtifactRefTargetKind;
  relation: ArtifactRefRelation;
  isPrimary: boolean;
  prNumber?: number | null;
  branchName?: string | null;
  repoFullName?: string | null;
}): FakeLinkRow {
  return {
    relation: opts.relation,
    isPrimary: opts.isPrimary,
    artifact: {
      slug: opts.slug,
      kind: opts.kind,
      prNumber: opts.prNumber ?? null,
      branchName: opts.branchName ?? null,
      repoFullName: opts.repoFullName ?? null,
    },
  };
}

function buildFakeTx(opts: {
  segments: FakeSegmentRow[];
  links: FakeLinkRow[];
}) {
  const updateManyCalls: UpdateManyCall[] = [];
  const findManyLinkCalls: FindManyLinkArgs[] = [];
  const tx = {
    sessionActivitySegment: {
      findMany: (_args: unknown) => Promise.resolve(opts.segments),
      updateMany: (args: UpdateManyCall) => {
        updateManyCalls.push(args);
        return Promise.resolve({ count: args.where.id.in.length });
      },
    },
    sessionArtifactLink: {
      findMany: (args: FindManyLinkArgs) => {
        findManyLinkCalls.push(args);
        return Promise.resolve(opts.links);
      },
    },
  };
  return { tx, updateManyCalls, findManyLinkCalls };
}

function asTx(tx: unknown): Prisma.TransactionClient {
  return tx as Prisma.TransactionClient;
}

describe("stampSegmentWorkItemRefs", () => {
  test("returns 0 and never queries artifact links when the session has no persisted segments", async () => {
    const { tx, findManyLinkCalls } = buildFakeTx({ segments: [], links: [] });

    const changed = await stampSegmentWorkItemRefs(
      asTx(tx),
      "session-empty",
      []
    );

    assert.equal(changed, 0);
    assert.equal(findManyLinkCalls.length, 0);
  });

  test("scopes the artifact-link query to the session and to only the ClosedloopArtifact, PullRequest, and Branch kinds", async () => {
    const { tx, findManyLinkCalls } = buildFakeTx({
      segments: [segRow("seg-1", 0, 1000, ACTIVITY_PHASE.Implement, null)],
      links: [],
    });

    await stampSegmentWorkItemRefs(asTx(tx), "session-9", []);

    assert.equal(findManyLinkCalls.length, 1);
    const args = findManyLinkCalls[0];
    assert.equal(args.where.sessionId, "session-9");
    assert.deepEqual(
      [...args.where.artifact.kind.in].sort(),
      [
        ArtifactRefTargetKind.Branch,
        ArtifactRefTargetKind.ClosedloopArtifact,
        ArtifactRefTargetKind.PullRequest,
      ].sort()
    );
  });

  test("stamps every non-idle segment with the session-level primary slug and leaves the idle segment null", async () => {
    const segments = [
      segRow("seg-a", 0, 1000, ACTIVITY_PHASE.Implement, null),
      segRow("seg-b", 1000, 2000, ACTIVITY_PHASE.Validate, null),
      segRow("seg-idle", 2000, 3000, ACTIVITY_PHASE.Idle, null),
    ];
    const links = [
      linkRow({
        slug: "FEA-100",
        kind: ArtifactRefTargetKind.ClosedloopArtifact,
        relation: ArtifactRefRelation.Workspace,
        isPrimary: true,
      }),
    ];
    const { tx, updateManyCalls } = buildFakeTx({ segments, links });

    const changed = await stampSegmentWorkItemRefs(asTx(tx), "session-1", []);

    assert.equal(changed, 2);
    assert.equal(updateManyCalls.length, 2);

    const setCall = updateManyCalls[0];
    assert.deepEqual(setCall.where.id.in, ["seg-a", "seg-b"]);
    assert.equal(setCall.data.workItemRef, "FEA-100");
    // Setting a real value is intentionally UNGUARDED — no workItemRef filter.
    assert.equal("workItemRef" in setCall.where, false);

    const clearCall = updateManyCalls[1];
    assert.deepEqual(clearCall.where.id.in, ["seg-idle"]);
    assert.equal(clearCall.data.workItemRef, null);
    // Clearing to NULL is guarded so the hot no-link import path touches 0 rows.
    assert.deepEqual(clearCall.where.workItemRef, { not: null });
  });

  test("still issues the write when the resolved value equals the already-stored value, but does not count it as changed", async () => {
    const segments = [
      segRow("seg-a", 0, 1000, ACTIVITY_PHASE.Implement, "FEA-100"),
    ];
    const links = [
      linkRow({
        slug: "FEA-100",
        kind: ArtifactRefTargetKind.ClosedloopArtifact,
        relation: ArtifactRefRelation.Workspace,
        isPrimary: true,
      }),
    ];
    const { tx, updateManyCalls } = buildFakeTx({ segments, links });

    const changed = await stampSegmentWorkItemRefs(asTx(tx), "session-1", []);

    assert.equal(changed, 0);
    assert.equal(updateManyCalls.length, 1);
    assert.deepEqual(updateManyCalls[0].where.id.in, ["seg-a"]);
    assert.equal(updateManyCalls[0].data.workItemRef, "FEA-100");
  });

  test("clears a stale stored ref back to null on an idle segment with no candidates, and counts it as changed", async () => {
    const segments = [segRow("seg-a", 0, 1000, ACTIVITY_PHASE.Idle, "STALE-1")];
    const { tx, updateManyCalls } = buildFakeTx({ segments, links: [] });

    const changed = await stampSegmentWorkItemRefs(asTx(tx), "session-1", []);

    assert.equal(changed, 1);
    assert.equal(updateManyCalls.length, 1);
    assert.deepEqual(updateManyCalls[0].where.id.in, ["seg-a"]);
    assert.equal(updateManyCalls[0].data.workItemRef, null);
    assert.deepEqual(updateManyCalls[0].where.workItemRef, { not: null });
  });

  test("splits an update batch larger than the SQLite parameter cap into chunks of EVENT_INSERT_PARAM_CAP - 2 ids", async () => {
    const total = EVENT_INSERT_PARAM_CAP - 2 + 2; // one full chunk plus a 2-row remainder
    const segments = Array.from({ length: total }, (_, i) =>
      segRow(
        `seg-${i}`,
        i * 1000,
        i * 1000 + 500,
        ACTIVITY_PHASE.Implement,
        null
      )
    );
    const links = [
      linkRow({
        slug: "FEA-900",
        kind: ArtifactRefTargetKind.ClosedloopArtifact,
        relation: ArtifactRefRelation.Workspace,
        isPrimary: true,
      }),
    ];
    const { tx, updateManyCalls } = buildFakeTx({ segments, links });

    const changed = await stampSegmentWorkItemRefs(asTx(tx), "session-1", []);

    assert.equal(changed, total);
    assert.equal(updateManyCalls.length, 2);
    assert.equal(
      updateManyCalls[0].where.id.in.length,
      EVENT_INSERT_PARAM_CAP - 2
    );
    assert.equal(updateManyCalls[1].where.id.in.length, 2);
    const allIds = [
      ...updateManyCalls[0].where.id.in,
      ...updateManyCalls[1].where.id.in,
    ];
    assert.deepEqual(
      allIds,
      segments.map((s) => s.id)
    );
  });

  test("accepts persisted BigInt span bounds (as the BIGINT columns surface via the delegate) without throwing", async () => {
    const segments = [
      segRow("seg-a", 0n, 1000n, ACTIVITY_PHASE.Implement, null),
      segRow("seg-b", 1000n, 2000n, ACTIVITY_PHASE.Implement, null),
    ];
    const links = [
      linkRow({
        slug: "FEA-1",
        kind: ArtifactRefTargetKind.ClosedloopArtifact,
        relation: ArtifactRefRelation.Workspace,
        isPrimary: true,
      }),
    ];
    const { tx, updateManyCalls } = buildFakeTx({ segments, links });

    const changed = await stampSegmentWorkItemRefs(asTx(tx), "session-1", []);

    assert.equal(changed, 2);
    assert.equal(updateManyCalls.length, 1);
    assert.deepEqual(updateManyCalls[0].where.id.in, ["seg-a", "seg-b"]);
  });
});
