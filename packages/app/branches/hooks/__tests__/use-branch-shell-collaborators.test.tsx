import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { createWrapper } from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBranchShellCollaborators } from "../use-branch-shell-collaborators";

/**
 * Held behind a mutable ref so a case can hand back a source with NO
 * `collaborators` method at all. `collaborators` is optional on
 * `BranchesDataSource`, and a `vi.fn` that resolves undefined is a different
 * path from the optional call short-circuiting (tamsinb, #8514).
 */
const held = vi.hoisted(() => ({
  source: { scope: "local" } as {
    scope: string;
    collaborators?: (ids: readonly string[]) => Promise<unknown>;
  },
}));
vi.mock("../../data-source/provider", () => ({
  useBranchesDataSource: () => held.source,
}));

function withSeam() {
  const collaborators = vi.fn();
  held.source = { scope: "local", collaborators };
  return collaborators;
}

describe("Branch collaborators read", () => {
  beforeEach(() => {
    // Each case installs its own source; never inherit the previous one's.
    held.source = { scope: "local" };
  });

  it("uses the active local adapter without a cloud read and never invents empty evidence", async () => {
    const collaborators = withSeam();
    collaborators.mockResolvedValue(
      unavailableArtifactCollaboratorBatchResponse(
        CollaboratorArtifactType.Branch,
        ["local-id"]
      )
    );
    const { result } = renderHook(
      () => useBranchShellCollaborators("local-id"),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(collaborators).toHaveBeenCalledWith(["local-id"]);
    expect(result.current.collaborators.availability).toBe(
      BranchIdentityAvailability.Unavailable
    );
  });

  it("does not treat an unauthorized or omitted entry as confirmed empty", async () => {
    withSeam().mockResolvedValue({ results: [] });
    const { result } = renderHook(
      () => useBranchShellCollaborators("omitted-id"),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.collaborators.availability).toBe(
      BranchIdentityAvailability.Unavailable
    );
  });

  it("degrades to unavailable when the source has no collaborators seam", async () => {
    // No method at all: `source.collaborators?.(…)` short-circuits to undefined
    // without ever calling anything. `beforeEach` already left it absent, so
    // nothing here reinstates it.
    expect(held.source.collaborators).toBeUndefined();
    const { result } = renderHook(
      () => useBranchShellCollaborators("no-seam"),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.collaborators.availability).toBe(
      BranchIdentityAvailability.Unavailable
    );
  });
});
