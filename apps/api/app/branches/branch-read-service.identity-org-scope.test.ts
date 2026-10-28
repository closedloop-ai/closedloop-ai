/**
 * ISS-8495 — the `organizationId` predicates on the Branch identity reads are a
 * security boundary, and they were unasserted.
 *
 * `resolveBranchIdentities` issues three org-scoped reads whose filter nobody
 * checked: the native `user.findMany` that resolves comment authors and push
 * owners to people, and BOTH comment-evidence reads (`thread.organizationId` on
 * the page-wide branch-comment scan and on the chunked session-comment scan).
 * Deleting `organizationId` from any of the three left every branches suite
 * green — the existing coverage asserts response bodies and statement counts,
 * and its two `comment.findMany` assertions are `expect.objectContaining` shapes
 * that never reach the org predicate.
 *
 * These cases therefore assert the DOWNSTREAM CALL SHAPE — the exact `where`
 * handed to Prisma — rather than the projected people, because a mocked read
 * returns the same rows whatever it is asked for, so a body assertion cannot
 * fail on a dropped filter. The sibling `gitHubUserConnection` read already has
 * its org-scope pinned in `branch-read-service.owner.test.ts`.
 */

import { ThreadSource } from "@repo/api/src/types/comment";
import { BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";
import { SESSION_COMMENT_ID_CHUNK_SIZE } from "./branch-read-service/page-comment-evidence";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "55555555-5555-4555-8555-555555555555";

/** Deterministic v4-shaped ids, so a multi-chunk seed needs no randomness. */
function sessionIdAt(index: number): string {
  const hex = index.toString(16).padStart(12, "0");
  return `55555555-5555-4555-8555-${hex}`;
}

/** Every `comment.findMany` call whose thread scan targets SESSIONS rather than
 * the branch — i.e. one entry per chunk of `readSessionCommentRows`. */
function sessionScanCalls(
  mock: ReturnType<typeof createMockDb>["comment"]["findMany"],
  branchArtifactId: string
) {
  return mock.mock.calls
    .map(([arg]) => arg as { where?: { thread?: Record<string, unknown> } })
    .filter((arg) => {
      const ids = (arg?.where?.thread?.artifactId as { in?: string[] })?.in;
      return Array.isArray(ids) && !ids.includes(branchArtifactId);
    });
}

/** The `select` the identity read uses, which the sibling owner-name read does
 * NOT — pinning it keeps these assertions on `resolveBranchIdentities`' own
 * `user.findMany` rather than matching whichever org-scoped User read ran. */
const IDENTITY_USER_SELECT = {
  id: true,
  clerkId: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
} as const;

describe("branch identity reads are organization-scoped (ISS-8495)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      {
        ...makeSessionLink(branchId, sessionId, "1.00", ownerId),
        branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
        branchParticipationObservedAt: now,
      },
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerId,
        clerkId: `user_${ownerId}`,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function listPage() {
    return branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });
  }

  /** Re-seeds the branch's session links with enough ids to cross
   * `SESSION_COMMENT_ID_CHUNK_SIZE`, so `readSessionCommentRows` issues more
   * than one query. */
  function seedSessionsAcrossTwoChunks(count: number) {
    mockDb.artifactLink.findMany.mockResolvedValue(
      Array.from({ length: count }, (_, index) => ({
        ...makeSessionLink(branchId, sessionIdAt(index), "1.00", ownerId),
        branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
        branchParticipationObservedAt: now,
      }))
    );
  }

  it("scopes the identity User read to the requesting organization", async () => {
    await listPage();

    expect(mockDb.user.findMany).toHaveBeenCalledWith({
      where: { organizationId, id: { in: [ownerId] } },
      select: IDENTITY_USER_SELECT,
    });
  });

  it("scopes the branch comment-evidence read to the requesting organization", async () => {
    await listPage();

    expect(mockDb.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          thread: {
            organizationId,
            source: { in: [ThreadSource.Native, ThreadSource.Liveblocks] },
            artifactId: { in: [branchId] },
          },
        },
      })
    );
  });

  it("scopes the session comment-evidence read to the requesting organization", async () => {
    await listPage();

    expect(mockDb.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          thread: {
            organizationId,
            source: { in: [ThreadSource.Native, ThreadSource.Liveblocks] },
            artifactId: { in: [sessionId] },
          },
        },
      })
    );
  });

  /* `toHaveBeenCalledWith` is satisfied by ANY one call, so a single-chunk case
   * cannot see a later chunk that drops the filter. `readSessionCommentRows`
   * issues one query per `SESSION_COMMENT_ID_CHUNK_SIZE` ids, so this seeds past
   * that boundary and asserts EVERY chunk carries the org predicate. */
  it("scopes every session comment-evidence chunk, not just the first", async () => {
    seedSessionsAcrossTwoChunks(SESSION_COMMENT_ID_CHUNK_SIZE + 1);

    await listPage();

    const calls = sessionScanCalls(mockDb.comment.findMany, branchId);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.where?.thread).toMatchObject({
        organizationId,
        source: { in: [ThreadSource.Native, ThreadSource.Liveblocks] },
      });
    }
  });
});
