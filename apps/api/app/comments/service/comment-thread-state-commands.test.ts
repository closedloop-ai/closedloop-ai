import { ThreadSource } from "@repo/api/src/types/comment";
import {
  CommentCapability,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("./comment-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./comment-target")>()),
  resolveThreadCommentTarget: vi.fn(),
}));

vi.mock("./comment-command-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./comment-command-pipeline")>()),
  runCommentCommand: vi.fn(),
}));

import { runCommentCommand } from "./comment-command-pipeline";
import {
  CommentArtifactType,
  resolveThreadCommentTarget,
  type SourcedCommentTarget,
} from "./comment-target";
import {
  reopenCommentThread,
  resolveCommentThread,
} from "./comment-thread-state-commands";

const ORG_ID = "org-1";
const THREAD_ID = "thread-1";
const viewer = { organizationId: ORG_ID, userId: "user-1" };
const located: SourcedCommentTarget = {
  target: {
    organizationId: ORG_ID,
    artifactId: "artifact-located",
    artifactType: CommentArtifactType.Session,
  },
  source: ThreadSource.Native,
};
const resolvedByLookup: SourcedCommentTarget = {
  target: {
    organizationId: ORG_ID,
    artifactId: "artifact-looked-up",
    artifactType: CommentArtifactType.Session,
  },
  source: ThreadSource.Native,
};
const present = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveThreadCommentTarget).mockResolvedValue(
    Result.ok(resolvedByLookup)
  );
  vi.mocked(runCommentCommand).mockResolvedValue(Result.ok("presented"));
});

describe.each([
  ["resolveCommentThread", resolveCommentThread, CommentCapability.Resolve],
  ["reopenCommentThread", reopenCommentThread, CommentCapability.Reopen],
] as const)("%s", (_name, command, capability) => {
  it("runs on the supplied located target without resolving the thread again", async () => {
    const result = await command({
      viewer,
      threadId: THREAD_ID,
      located,
      present,
    });

    expect(result).toEqual(Result.ok("presented"));
    expect(resolveThreadCommentTarget).not.toHaveBeenCalled();
    expect(runCommentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        target: located.target,
        policyKey: CommentPolicyKey.NativeSession,
        capability,
      })
    );
  });

  it("resolves the thread's target when none is supplied", async () => {
    await command({ viewer, threadId: THREAD_ID, present });

    expect(resolveThreadCommentTarget).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      threadId: THREAD_ID,
    });
    expect(runCommentCommand).toHaveBeenCalledWith(
      expect.objectContaining({ target: resolvedByLookup.target, capability })
    );
  });
});
