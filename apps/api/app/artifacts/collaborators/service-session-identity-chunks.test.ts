import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const evidence = vi.hoisted(() => ({
  readSessions: vi.fn(),
  readComments: vi.fn(),
}));
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: vi.fn(),
}));
vi.mock("@/app/agent-sessions/service/session-collaborator-evidence", () => ({
  readSessionCollaboratorEvidence: evidence.readSessions,
}));
vi.mock(
  "@/app/agent-sessions/service/session-collaborator-comment-evidence",
  () => ({
    readSessionCommentEvidence: evidence.readComments,
  })
);

import {
  artifactCollaboratorsService,
  SESSION_USER_READ_CHUNK_SIZE,
} from "./service";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_IDS = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;
const editorIds = Array.from(
  { length: SESSION_USER_READ_CHUNK_SIZE + 1 },
  (_, index) => `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`
);
const findMany = vi.fn();
const db = { user: { findMany }, $queryRaw: vi.fn() };

describe("Session collaborator profile binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withDb).mockImplementation(
      async (read) => await read(db as never)
    );
    db.$queryRaw.mockResolvedValue(
      SESSION_IDS.map((artifactId) => ({
        artifactId,
        source: null,
        actorId: null,
        commentCount: 0,
        hasInteractionCoverage: true,
      }))
    );
    evidence.readSessions.mockResolvedValue(
      new Map(
        SESSION_IDS.map((id, index) => [
          id,
          {
            ownerId: null,
            editorIds:
              index === 0 ? editorIds.slice(0, 500) : editorIds.slice(500),
            editorAvailability: BranchIdentityAvailability.Complete,
          },
        ])
      )
    );
    evidence.readComments.mockResolvedValue(new Map());
    findMany.mockImplementation(
      async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({
          id,
          clerkId: `clerk_${id}`,
          email: `${id}@example.test`,
          firstName: null,
          lastName: null,
          avatarUrl: null,
        }))
    );
  });

  it("reads every editor over multiple bounded org-scoped user queries", async () => {
    const result = await artifactCollaboratorsService.readBatch(
      ORGANIZATION_ID,
      {
        artifactType: ArtifactType.Session,
        artifactIds: [...SESSION_IDS],
      }
    );

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          organizationId: ORGANIZATION_ID,
          id: { in: editorIds.slice(0, SESSION_USER_READ_CHUNK_SIZE) },
        },
      })
    );
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          organizationId: ORGANIZATION_ID,
          id: { in: editorIds.slice(SESSION_USER_READ_CHUNK_SIZE) },
        },
      })
    );
    expect(
      result.results.map((entry) => entry.collaborators.people.length)
    ).toEqual([500, editorIds.length - 500]);
    expect(
      result.results.every(
        (entry) =>
          entry.collaborators.availability ===
          BranchIdentityAvailability.Complete
      )
    ).toBe(true);
  });
});
