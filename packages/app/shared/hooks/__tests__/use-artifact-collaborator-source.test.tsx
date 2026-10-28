import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createWrapper } from "../../test-utils";
import { useArtifactCollaboratorSource } from "../use-artifact-collaborators";

describe("shared artifact interaction source port", () => {
  it("batches local identities through the selected source and separates source caches", async () => {
    const local = vi
      .fn()
      .mockResolvedValue(
        unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Branch,
          ["local-id"]
        )
      );
    const cloud = vi.fn().mockResolvedValue(null);
    const { result, rerender } = renderHook(
      ({ scope }) =>
        useArtifactCollaboratorSource({
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: ["local-id", "local-id"],
          queryScope: [scope],
          read: scope === "local" ? local : cloud,
        }),
      { wrapper: createWrapper(), initialProps: { scope: "local" } }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(local).toHaveBeenCalledWith(["local-id"]);
    expect(cloud).not.toHaveBeenCalled();
    expect(result.current.data?.get("local-id")?.commentCount).toBeUndefined();
    rerender({ scope: "cloud" });
    await waitFor(() => expect(cloud).toHaveBeenCalledWith(["local-id"]));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.size).toBe(0);
  });
});
