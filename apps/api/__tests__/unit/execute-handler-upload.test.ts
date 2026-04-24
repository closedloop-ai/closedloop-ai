import type { JsonObject } from "@repo/api/src/types/common";
import { vi } from "vitest";

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import("../fixtures/mock-modules");
  return createLogMockModule();
});

vi.mock("@/lib/loops/ingest-repo-execution-results", () => ({
  ingestRepoExecutionResults: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/loops/loop-document-ingestion", () => ({
  parseJsonArtifact: vi.fn(() => null),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
  downloadPromptSnapshotMarkdownEntries: vi.fn(),
}));

import { LoopCommand } from "@repo/api/src/types/loop";
import { ingestRepoExecutionResults } from "@/lib/loops/ingest-repo-execution-results";
import { executeHandler } from "@/lib/loops/loop-commands/execute-handler";
import { buildLoop } from "../fixtures/loop";

const mockIngestRepoExecutionResults =
  ingestRepoExecutionResults as unknown as ReturnType<typeof vi.fn>;

describe("executeHandler upload ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves legacy base_branch-only v1 execution uploads", async () => {
    const loop = buildLoop({ command: LoopCommand.Execute });
    const uploadedArtifacts = {
      executionResult: {
        has_changes: true,
        pr_url: "https://github.com/org/repo/pull/42",
        pr_number: "42",
        pr_title: "Symphony: feature",
        branch_name: "symphony/feature",
        base_branch: "develop",
        commit_sha: "abc123",
        github_id: 999,
      },
    } satisfies JsonObject;

    await executeHandler.uploadAndIngest(uploadedArtifacts, loop, "org-1");

    expect(mockIngestRepoExecutionResults).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        workstreamId: loop.workstreamId,
        documentId: loop.documentId,
        loopId: loop.id,
      }),
      [
        expect.objectContaining({
          status: "success",
          fullName: "org/repo",
          prNumber: 42,
          branchName: "symphony/feature",
          baseBranch: "develop",
          commitSha: "abc123",
          githubId: 999,
        }),
      ],
      expect.objectContaining({
        codeJudgesReport: null,
        promptsSnapshot: null,
      })
    );
  });

  it("falls back to main for legacy v1 execution uploads without a base branch", async () => {
    const loop = buildLoop({ command: LoopCommand.Execute });
    const uploadedArtifacts = {
      executionResult: {
        has_changes: true,
        pr_url: "https://github.com/org/repo/pull/43",
        pr_number: "43",
        branch_name: "symphony/default-base",
      },
    } satisfies JsonObject;

    await executeHandler.uploadAndIngest(uploadedArtifacts, loop, "org-1");

    expect(mockIngestRepoExecutionResults).toHaveBeenCalledWith(
      expect.any(Object),
      [
        expect.objectContaining({
          status: "success",
          prNumber: 43,
          baseBranch: "main",
        }),
      ],
      expect.any(Object)
    );
  });
});
