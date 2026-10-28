import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { createWrapper } from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSessionShellCollaborators } from "../use-session-shell-collaborators";

const source = vi.hoisted(() => ({ scope: "local", collaborators: vi.fn() }));
vi.mock("../../data-source/provider", () => ({
  useAgentSessionsDataSource: () => source,
}));

describe("Session collaborators read", () => {
  it("uses the active local adapter without a cloud read and never invents empty evidence", async () => {
    source.collaborators.mockResolvedValue(
      unavailableArtifactCollaboratorBatchResponse(
        CollaboratorArtifactType.Session,
        ["local-id"]
      )
    );
    const { result } = renderHook(
      () => useSessionShellCollaborators("local-id"),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(source.collaborators).toHaveBeenCalledWith(["local-id"]);
    expect(result.current.collaborators.availability).toBe(
      BranchIdentityAvailability.Unavailable
    );
  });

  it("does not treat an unauthorized or omitted entry as confirmed empty", async () => {
    source.collaborators.mockResolvedValue({ results: [] });
    const { result } = renderHook(
      () => useSessionShellCollaborators("omitted-id"),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.collaborators.availability).toBe(
      BranchIdentityAvailability.Unavailable
    );
  });
});
