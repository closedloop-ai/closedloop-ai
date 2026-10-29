import { randomUUID } from "node:crypto";
import { BranchStatus } from "@repo/api/src/types/branch";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { STAFF_EMAIL_DOMAIN } from "@repo/api/src/types/staff-email";
import { ArtifactType, type TransactionClient, withDb } from "@repo/database";
import { createEligibleBranch } from "@/__tests__/support/trace-comments/legacy-route.test-fixtures";
import {
  type createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import type { CommentViewer } from "@/app/comments/service/comment-capabilities";
import {
  CommentArtifactType,
  type CommentTarget,
} from "@/app/comments/service/comment-target";

export type CommentTestOrg = {
  organizationId: string;
  author: CommentViewer;
  other: CommentViewer;
  staff: CommentViewer;
  session: CommentTarget;
  branch: CommentTarget;
};

export type CommentOrgTracker = ReturnType<
  typeof createCommittedTestOrganizationTracker
>;

const ACTIVITY_AT = new Date("2026-07-01T00:00:00.000Z");

/** One org with an author, a second member, a staff member, a Session and a Branch. */
export async function seedCommentTestOrg(
  tracker: CommentOrgTracker
): Promise<CommentTestOrg> {
  const organizationId = await tracker.create();
  const suffix = randomUUID().slice(0, 8);
  const [author, other, staff] = await Promise.all([
    createTestUser(organizationId, { firstName: "Ada", lastName: "Author" }),
    createTestUser(organizationId, { firstName: "Oli", lastName: "Other" }),
    createTestUser(organizationId, {
      firstName: "Sam",
      lastName: "Staff",
      email: `staff+${suffix}${STAFF_EMAIL_DOMAIN}`,
    }),
  ]);
  const { sessionArtifactId, branchArtifactId } = await withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: `session-${suffix}`,
        status: BranchStatus.Open,
        // Ingest stamps the uploader as Created by, which the external-id
        // lookup scopes on (ISS-12251 D-4).
        createdById: author.id,
      },
      select: { id: true },
    });
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: author.id,
        machineName: `machine-${suffix}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: session.id,
        computeTargetId: computeTarget.id,
        externalSessionId: `ext-${suffix}`,
        harness: "claude",
        sessionStartedAt: ACTIVITY_AT,
        sessionUpdatedAt: ACTIVITY_AT,
        lastActivityAt: ACTIVITY_AT,
      },
      select: { artifactId: true },
    });
    const branchArtifactId = await createEligibleBranch(
      db,
      organizationId,
      author.id,
      suffix
    );
    return { sessionArtifactId: session.id, branchArtifactId };
  });
  const viewer = (userId: string) => ({ organizationId, userId });
  return {
    organizationId,
    author: viewer(author.id),
    other: viewer(other.id),
    staff: viewer(staff.id),
    session: {
      organizationId,
      artifactId: sessionArtifactId,
      artifactType: CommentArtifactType.Session,
    },
    branch: {
      organizationId,
      artifactId: branchArtifactId,
      artifactType: CommentArtifactType.Branch,
    },
  };
}

/**
 * Work released from inside a command's transaction that still runs on a pooled
 * connection of its own, as a concurrent request would. `withDb` joins the
 * transaction in its async context, and a promise continuation runs in the
 * context it was registered in, so call this before the transaction opens.
 */
export function onOwnConnection<T>(
  work: (db: TransactionClient) => Promise<T>
): { run: () => Promise<T> } {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = released.then(() => withDb(work));
  return {
    run: () => {
      release();
      return done;
    },
  };
}

/** The Postgres backend serving `db`, which tells two connections apart. */
export async function backendPid(db: TransactionClient): Promise<number> {
  const [row] = await db.$queryRaw<
    { pid: number }[]
  >`SELECT pg_backend_pid() AS pid`;
  return row?.pid ?? -1;
}

export function commentTraceAnchor(row: number) {
  return {
    kind: CommentAnchorKind.Trace,
    traceId: `trace-${row}`,
    turnId: `turn-${row}`,
    row,
    selectedText: "selected",
    sourceText: "selected text",
    startOffset: 0,
    endOffset: 8,
  };
}
