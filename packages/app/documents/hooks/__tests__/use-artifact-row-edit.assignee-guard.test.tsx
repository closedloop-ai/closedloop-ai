import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ArtifactRowEditInput } from "../use-artifact-row-edit";
import { useArtifactRowEdit } from "../use-artifact-row-edit";

/**
 * ISS-11198 (whitlockk review, PR #7924): an artifact row's assignee pick carries
 * the assignee the server last confirmed as its guard. The field's queue
 * issues a second pick only once the first has settled, so the second expects
 * the first when it was accepted and the original when it was refused — never
 * a value the server does not hold.
 */

describe("useArtifactRowEdit assignee guard", () => {
  test("a pick queued behind an accepted one expects that one", async () => {
    const commit = vi.fn<(input: ArtifactRowEditInput) => Promise<unknown>>(
      () => Promise.resolve({})
    );
    const { result } = renderRow(commit);

    act(() => result.current.onAssigneeChange?.(ADA.id));
    act(() => result.current.onAssigneeChange?.(GRACE.id));

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit.mock.calls).toEqual([
      [{ id: ARTIFACT_ID, assigneeId: ADA.id, expectedAssigneeId: null }],
      [{ id: ARTIFACT_ID, assigneeId: GRACE.id, expectedAssigneeId: ADA.id }],
    ]);
  });

  test("a pick queued behind a refused one expects the assignee before it", async () => {
    const commit = vi
      .fn<(input: ArtifactRowEditInput) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue({});
    const { result } = renderRow(commit);

    act(() => result.current.onAssigneeChange?.(ADA.id));
    act(() => result.current.onAssigneeChange?.(GRACE.id));

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit.mock.calls[1]).toEqual([
      { id: ARTIFACT_ID, assigneeId: GRACE.id, expectedAssigneeId: null },
    ]);
  });
});

function renderRow(commit: (input: ArtifactRowEditInput) => Promise<unknown>) {
  return renderHook(() =>
    useArtifactRowEdit(
      createMockDocument({
        id: ARTIFACT_ID,
        assigneeId: null,
        assignee: null,
      }),
      { commit, users: [ADA, GRACE] }
    )
  );
}

const ARTIFACT_ID = "artifact-123";
const ADA = {
  id: "user-ada",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
};
const GRACE = {
  id: "user-grace",
  email: "grace@example.com",
  firstName: "Grace",
  lastName: "Hopper",
  avatarUrl: null,
};
