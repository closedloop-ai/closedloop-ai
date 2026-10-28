import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactCommentKeys } from "../../comments/artifact-comments-cache";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "../../test-utils";
import { useArtifactCollaborators } from "../use-artifact-collaborators";

const held = vi.hoisted(() => ({
  read: vi.fn(),
  api: { get: vi.fn() },
  orgId: "org-a",
  userId: "user-a",
}));
vi.mock("../../api/use-api-client", () => ({ useApiClient: () => held.api }));
vi.mock("../../api/provider", () => ({
  useApiAdapter: () => ({ deploymentId: "test" }),
}));
vi.mock("../../auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => ({ orgId: held.orgId, userId: held.userId }),
}));
vi.mock("../../lib/artifact-collaborators", () => ({
  readArtifactCollaborators: held.read,
}));
const id = "00000000-0000-4000-8000-000000000001";

describe("shared artifact participation read", () => {
  beforeEach(() => {
    held.orgId = "org-a";
    held.read.mockReset();
    held.read.mockResolvedValue(
      unavailableArtifactCollaboratorBatchResponse(
        CollaboratorArtifactType.Document,
        [id]
      )
    );
  });

  it("reads only enabled visible identities, retaining unknown count on an older response", async () => {
    const client = createTestQueryClient();
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useArtifactCollaborators({
          artifactType: CollaboratorArtifactType.Document,
          artifactIds: [id, id],
          enabled,
        }),
      {
        wrapper: createWrapperWithClient(client),
        initialProps: { enabled: false },
      }
    );
    expect(held.read).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(held.read).toHaveBeenCalledWith(
      held.api,
      CollaboratorArtifactType.Document,
      [id]
    );
    expect(result.current.data?.get(id)?.commentCount).toBeUndefined();
  });

  it("keeps one comment-cache subscription across re-renders with an unchanged scope", async () => {
    const client = createTestQueryClient();
    const subscribe = vi.spyOn(client.getQueryCache(), "subscribe");
    const { result, rerender } = renderHook(
      () =>
        useArtifactCollaborators({
          artifactType: CollaboratorArtifactType.Document,
          artifactIds: [id],
        }),
      { wrapper: createWrapperWithClient(client) }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const subscriptions = subscribe.mock.calls.length;
    rerender();
    rerender();
    expect(subscribe).toHaveBeenCalledTimes(subscriptions);
  });

  it("refreshes the mounted cohort when direct or inline comment data changes", async () => {
    const client = createTestQueryClient();
    const { result } = renderHook(
      () =>
        useArtifactCollaborators({
          artifactType: CollaboratorArtifactType.Document,
          artifactIds: [id],
        }),
      { wrapper: createWrapperWithClient(client) }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const calls = held.read.mock.calls.length;
    act(() => {
      client.setQueryData(
        artifactCommentKeys.target({ id: "another-artifact" }),
        { artifactId: "another-artifact" }
      );
    });
    expect(held.read).toHaveBeenCalledTimes(calls);
    const response = unavailableArtifactCollaboratorBatchResponse(
      CollaboratorArtifactType.Document,
      [id]
    );
    response.results[0].commentCount = 2;
    held.read.mockResolvedValue(response);
    act(() => {
      client.setQueryData(artifactCommentKeys.target({ id }), {
        artifactId: id,
      });
    });
    await waitFor(() =>
      expect(result.current.data?.get(id)?.commentCount).toBe(2)
    );
  });

  it("does not reuse one organization's participation for another", async () => {
    const client = createTestQueryClient();
    const { result, rerender } = renderHook(
      () =>
        useArtifactCollaborators({
          artifactType: CollaboratorArtifactType.Document,
          artifactIds: [id],
        }),
      { wrapper: createWrapperWithClient(client) }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    held.orgId = "org-b";
    held.read.mockResolvedValue({ results: [] });
    rerender();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.size).toBe(0);
    expect(held.read).toHaveBeenCalledTimes(2);
  });
});
