import {
  ArtifactBulkAction,
  ArtifactBulkKind,
} from "@repo/api/src/types/artifact-bulk-action";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Priority } from "@repo/api/src/types/common";
import { createArtifactBulkActionRegistry } from "@repo/app/shared/bulk-actions/registry";
import { describe, expect, it, vi } from "vitest";
import { executeProjectSelectionPriority } from "./project-selection-priority";

describe("Project-list mixed priority routing", () => {
  it("writes Documents by batch and Sessions/Branches by their own paths, preserving per-item failures", async () => {
    const rows = [
      { id: "branch-1", kind: ArtifactBulkKind.Branch },
      { id: "document-1", kind: ArtifactBulkKind.Document },
      { id: "session-1", kind: ArtifactBulkKind.Session },
      { id: "deployment-1", kind: ArtifactBulkKind.Deployment },
    ];
    const post = vi.fn().mockResolvedValue({
      results: [batchItemApplied("document-1")],
      transactionId: "transaction-1",
    });
    const patch = vi.fn((path: string) =>
      path.startsWith("/agent-sessions/")
        ? Promise.reject(new Error("TEST ONLY: refused"))
        : Promise.resolve({ id: "branch-1" })
    );
    const entries = createArtifactBulkActionRegistry({
      rows,
      host: {
        post,
        pageKinds: [
          ArtifactBulkKind.Document,
          ArtifactBulkKind.Session,
          ArtifactBulkKind.Branch,
          ArtifactBulkKind.Deployment,
        ],
        executors: {
          [ArtifactBulkAction.ChangePriority]: (applicableRows, value) =>
            executeProjectSelectionPriority(applicableRows, value, {
              post,
              patch,
            }),
        },
      },
    });
    const priority = entries.find(
      (entry) => entry.id === ArtifactBulkAction.ChangePriority
    );
    expect(priority?.partition?.inapplicableRows).toEqual([rows[3]]);

    await expect(priority?.execute(Priority.High)).resolves.toEqual({
      results: [
        batchItemApplied("branch-1"),
        batchItemApplied("document-1"),
        batchItemFailed("session-1", BatchItemFailureCode.OutcomeUnknown),
      ],
      transactionIds: ["transaction-1"],
    });
    expect(post).toHaveBeenCalledWith(
      `${BatchMutationRoute.DocumentsUpdatePriority}/v2`,
      {
        documentIds: ["document-1"],
        priority: Priority.High,
        surface: ArtifactStatusEditSurface.Bulk,
      }
    );
    expect(patch).toHaveBeenCalledWith("/branches/branch-1", {
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Bulk,
    });
    expect(patch).toHaveBeenCalledWith("/agent-sessions/session-1", {
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Bulk,
    });
    expect(patch).not.toHaveBeenCalledWith(
      "/deployments/deployment-1",
      expect.anything()
    );
  });
});
