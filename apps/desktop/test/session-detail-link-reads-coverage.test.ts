/**
 * @file session-detail-link-reads-coverage.test.ts
 * @description ISS-8730 coverage for session-detail-link-reads.ts: the
 * session-scoped branch-link and document-link reads a session detail pane
 * needs beyond what the batch sync loader carries. Exercised against a
 * recording mock of DbHostPrisma's `sessionArtifactLink.findMany`, so the
 * query shape and the dedupe/mapping logic are pinned without a real SQLite
 * fixture.
 *
 * Pins CURRENT behavior only; does not change apps/desktop source.
 */
import assert from "node:assert/strict";
import {
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS,
} from "@repo/api/src/types/session-artifact-link";
import { describe, test } from "vitest";
import {
  BRANCH_PUSH_METHOD_VALUES,
  BRANCH_WRITE_METHOD_VALUES,
} from "../src/main/database/db-constants.js";
import type { DbHostPrisma } from "../src/main/database/prisma-client.js";
import {
  createSessionDetailLinkReaders,
  readSessionBranchLinkKeys,
  readSessionDocumentArtifactRefs,
  SESSION_BRANCH_LINK_KEY_SCAN_LIMIT,
  SESSION_DOCUMENT_LINK_SCAN_LIMIT,
} from "../src/main/database/session-detail-link-reads.js";

type FindManyArgs = {
  where: unknown;
  select: unknown;
  orderBy: unknown;
  take: unknown;
};

function createRecordingPrisma(rows: unknown[]): {
  prisma: DbHostPrisma;
  calls: FindManyArgs[];
} {
  const calls: FindManyArgs[] = [];
  const prisma = {
    client: {
      sessionArtifactLink: {
        findMany: (args: FindManyArgs) => {
          calls.push(args);
          return Promise.resolve(rows);
        },
      },
    },
  } as unknown as DbHostPrisma;
  return { prisma, calls };
}

function branchLinkRow(overrides: {
  repoFullName?: string | null;
  branchName?: string | null;
  firstPushedAt?: string | null;
  pushLinkCount?: number;
}) {
  return {
    artifact: {
      repoFullName:
        overrides.repoFullName === undefined
          ? "acme/repo"
          : overrides.repoFullName,
      branchName:
        overrides.branchName === undefined ? "feature/x" : overrides.branchName,
      firstPushedAt: overrides.firstPushedAt ?? null,
      artifactLinks: Array.from(
        { length: overrides.pushLinkCount ?? 0 },
        (_, i) => ({ id: `push-${i}` })
      ),
    },
  };
}

describe("readSessionBranchLinkKeys", () => {
  test("sends the scan-limit-bounded, newest-first query scoped to branch-write methods", async () => {
    const { prisma, calls } = createRecordingPrisma([]);
    await readSessionBranchLinkKeys(prisma, "session-1");
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(call.orderBy, [{ observedAt: "desc" }]);
    assert.equal(call.take, SESSION_BRANCH_LINK_KEY_SCAN_LIMIT);

    // Asserted WHOLE, not field by field. The mapping cases below feed
    // `artifactLinks` to the mapper directly, so the query never runs in them —
    // which leaves both predicates that actually decide `hasLocalPublication`
    // unpinned unless they are pinned here. Drop the nested
    // `artifactLinks.where` and any link on the branch counts as a push, so a
    // session that only READ a branch starts reporting it published; drop
    // `branchName: { not: null }` and branch-less artifacts enter the scan.
    assert.deepEqual(call.where, {
      sessionId: "session-1",
      method: { in: [...BRANCH_WRITE_METHOD_VALUES] },
      artifact: {
        kind: ArtifactRefTargetKind.Branch,
        branchName: { not: null },
      },
    });
    assert.deepEqual(call.select, {
      artifact: {
        select: {
          repoFullName: true,
          branchName: true,
          firstPushedAt: true,
          artifactLinks: {
            where: { method: { in: [...BRANCH_PUSH_METHOD_VALUES] } },
            select: { id: true },
            take: 1,
          },
        },
      },
    });
  });

  test("maps a non-duplicate row, deriving hasLocalPublication from firstPushedAt OR a push link", async () => {
    const { prisma } = createRecordingPrisma([
      branchLinkRow({ firstPushedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    const rows = await readSessionBranchLinkKeys(prisma, "session-1");
    assert.deepEqual(rows, [
      {
        repoFullName: "acme/repo",
        branchName: "feature/x",
        hasLocalPublication: true,
      },
    ]);
  });

  test("a null repoFullName maps to null on the row, and a push-link count alone still counts as published", async () => {
    const { prisma } = createRecordingPrisma([
      branchLinkRow({ repoFullName: null, pushLinkCount: 1 }),
    ]);
    const [row] = await readSessionBranchLinkKeys(prisma, "session-1");
    assert.equal(row.repoFullName, null);
    assert.equal(row.hasLocalPublication, true);
  });

  test("skips a link row whose artifact carries no branchName", async () => {
    const { prisma } = createRecordingPrisma([
      branchLinkRow({ branchName: null }),
      branchLinkRow({ branchName: "feature/y" }),
    ]);
    const rows = await readSessionBranchLinkKeys(prisma, "session-1");
    assert.deepEqual(
      rows.map((r) => r.branchName),
      ["feature/y"]
    );
  });

  test("dedupe: a later-observed UNPUBLISHED duplicate never downgrades an already-published entry", async () => {
    const { prisma } = createRecordingPrisma([
      // newest-observed-first, as the query itself returns rows.
      branchLinkRow({ firstPushedAt: "2026-01-01T00:00:00.000Z" }),
      branchLinkRow({ firstPushedAt: null, pushLinkCount: 0 }),
    ]);
    const rows = await readSessionBranchLinkKeys(prisma, "session-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hasLocalPublication, true);
  });

  test("dedupe: a later-observed PUBLISHED duplicate upgrades an earlier unpublished entry", async () => {
    // ISS-5617 review #4650: recency alone cannot pick a winner between two
    // candidate rows for the same identity, so publication status can override
    // observation order.
    const { prisma } = createRecordingPrisma([
      branchLinkRow({ firstPushedAt: null, pushLinkCount: 0 }),
      branchLinkRow({ firstPushedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    const rows = await readSessionBranchLinkKeys(prisma, "session-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hasLocalPublication, true);
  });

  test("keeps distinct (repoFullName, branchName) identities separate, in first-insertion order", async () => {
    const { prisma } = createRecordingPrisma([
      branchLinkRow({ repoFullName: "acme/repo-a", branchName: "feature/x" }),
      branchLinkRow({ repoFullName: "acme/repo-b", branchName: "feature/x" }),
      // A duplicate of the FIRST identity, arriving third: the Map updates the
      // existing key's value in place rather than moving it to the end.
      branchLinkRow({
        repoFullName: "acme/repo-a",
        branchName: "feature/x",
        firstPushedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const rows = await readSessionBranchLinkKeys(prisma, "session-1");
    assert.deepEqual(
      rows.map((r) => r.repoFullName),
      ["acme/repo-a", "acme/repo-b"]
    );
    assert.equal(rows[0].hasLocalPublication, true);
  });
});

describe("readSessionDocumentArtifactRefs", () => {
  test("sends the cloud-ceiling-bounded, created-at-ascending query for closedloop_artifact links, probing one row past the ceiling", async () => {
    const { prisma, calls } = createRecordingPrisma([]);
    await readSessionDocumentArtifactRefs(prisma, "session-1");
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(call.orderBy, [{ createdAt: "asc" }]);
    // ISS-9863: LIMIT + 1, so a full read is observed as an overflow rather
    // than mistaken for a session with exactly LIMIT links.
    assert.equal(call.take, SESSION_DOCUMENT_LINK_SCAN_LIMIT + 1);
    assert.equal(SESSION_DOCUMENT_LINK_SCAN_LIMIT, MAX_SYNCED_ARTIFACT_REFS);
    const where = call.where as {
      sessionId: string;
      artifact: { kind: string; slug: unknown };
    };
    assert.equal(where.sessionId, "session-1");
    assert.equal(where.artifact.kind, ArtifactRefTargetKind.ClosedloopArtifact);
  });

  test("maps isPrimary/method/slug into a ClosedloopArtifact ref", async () => {
    const { prisma } = createRecordingPrisma([
      { isPrimary: true, method: "mention", artifact: { slug: "ISS-1" } },
    ]);
    const read = await readSessionDocumentArtifactRefs(prisma, "session-1");
    assert.deepEqual(read, {
      refs: [
        {
          kind: ArtifactRefTargetKind.ClosedloopArtifact,
          slug: "ISS-1",
          isPrimary: true,
          method: "mention",
        },
      ],
      truncated: false,
    });
  });

  test("ISS-9863: a probe row past the ceiling raises truncated and is cut from the served refs", async () => {
    const rows = Array.from(
      { length: SESSION_DOCUMENT_LINK_SCAN_LIMIT + 1 },
      (_, index) => ({
        isPrimary: false,
        method: "mention",
        artifact: { slug: `ISS-${index}` },
      })
    );
    const { prisma } = createRecordingPrisma(rows);
    const read = await readSessionDocumentArtifactRefs(prisma, "session-1");
    assert.equal(read.truncated, true);
    assert.equal(read.refs.length, SESSION_DOCUMENT_LINK_SCAN_LIMIT);
    assert.equal(
      (read.refs.at(-1) as { slug: string }).slug,
      `ISS-${SESSION_DOCUMENT_LINK_SCAN_LIMIT - 1}`,
      "the probe row itself is never served"
    );
  });

  test("ISS-9863: a slug-less row in the probe position still reports truncated, on the safe side", async () => {
    const rows = Array.from(
      { length: SESSION_DOCUMENT_LINK_SCAN_LIMIT + 1 },
      (_, index) => ({
        isPrimary: false,
        method: "mention",
        artifact: {
          slug:
            index === SESSION_DOCUMENT_LINK_SCAN_LIMIT ? null : `ISS-${index}`,
        },
      })
    );
    const { prisma } = createRecordingPrisma(rows);
    const read = await readSessionDocumentArtifactRefs(prisma, "session-1");
    // The store held more ROWS than the ceiling; whether the extra row would
    // have folded to a ref is unknowable from the probe, so no total is claimed.
    assert.equal(read.truncated, true);
    assert.equal(read.refs.length, SESSION_DOCUMENT_LINK_SCAN_LIMIT);
  });

  test("ISS-9863: exactly the ceiling's worth of rows is complete, not truncated", async () => {
    const rows = Array.from(
      { length: SESSION_DOCUMENT_LINK_SCAN_LIMIT },
      (_, index) => ({
        isPrimary: false,
        method: "mention",
        artifact: { slug: `ISS-${index}` },
      })
    );
    const { prisma } = createRecordingPrisma(rows);
    const read = await readSessionDocumentArtifactRefs(prisma, "session-1");
    assert.equal(read.truncated, false);
    assert.equal(read.refs.length, SESSION_DOCUMENT_LINK_SCAN_LIMIT);
  });

  test("drops a link row whose artifact has no slug instead of emitting a null-slug ref", async () => {
    const { prisma } = createRecordingPrisma([
      { isPrimary: false, method: "mention", artifact: { slug: null } },
      { isPrimary: true, method: "mention", artifact: { slug: "ISS-2" } },
    ]);
    const { refs } = await readSessionDocumentArtifactRefs(prisma, "session-1");
    assert.deepEqual(
      refs.map((r) => (r as { slug: string }).slug),
      ["ISS-2"]
    );
  });
});

describe("createSessionDetailLinkReaders", () => {
  test("wires loadSessionBranchLinkKeys and loadSessionDocumentArtifactRefs to the given sessionId", async () => {
    const branchCalls: FindManyArgs[] = [];
    const docCalls: FindManyArgs[] = [];
    const prisma = {
      client: {
        sessionArtifactLink: {
          findMany: (args: FindManyArgs) => {
            const where = args.where as { artifact?: { kind?: string } };
            if (where.artifact?.kind === ArtifactRefTargetKind.Branch) {
              branchCalls.push(args);
              return Promise.resolve([branchLinkRow({})]);
            }
            docCalls.push(args);
            return Promise.resolve([
              {
                isPrimary: true,
                method: "mention",
                artifact: { slug: "ISS-9" },
              },
            ]);
          },
        },
      },
    } as unknown as DbHostPrisma;

    const readers = createSessionDetailLinkReaders(prisma);
    const [branchKeys, docRefs] = await Promise.all([
      readers.loadSessionBranchLinkKeys("session-42"),
      readers.loadSessionDocumentArtifactRefs("session-42"),
    ]);

    assert.equal(branchCalls.length, 1);
    assert.equal(
      (branchCalls[0].where as { sessionId: string }).sessionId,
      "session-42"
    );
    assert.equal(docCalls.length, 1);
    assert.equal(
      (docCalls[0].where as { sessionId: string }).sessionId,
      "session-42"
    );
    assert.deepEqual(branchKeys, [
      {
        repoFullName: "acme/repo",
        branchName: "feature/x",
        hasLocalPublication: false,
      },
    ]);
    assert.deepEqual(docRefs, {
      refs: [
        {
          kind: ArtifactRefTargetKind.ClosedloopArtifact,
          slug: "ISS-9",
          isPrimary: true,
          method: "mention",
        },
      ],
      truncated: false,
    });
  });
});
