/**
 * ISS-9665 — clearing a row's priority, through the production hook.
 *
 * WHAT THIS GUARDS, STATED PRECISELY. `useArtifactRowEdit` had no test file at
 * all, and it is the only path by which a grid row's priority reaches the API.
 * Two facts are pinned here, and both were verified to fail under a mutation:
 *
 *  - The WRITE BOUNDARY. `commit` receives `priority: null` — not `""` (the
 *    ledger's sentinel), not `MEDIUM`, not an omitted key. Folding anywhere on
 *    this path silently turns the user's "clear" into "set to Medium", and an
 *    omitted key turns it into "leave it alone". Reintroducing the fold at the
 *    commit call makes this case red.
 *  - The ROLLBACK. A refused write must put back the value the artifact
 *    actually holds. A refused CLEAR restores the real priority (URGENT here,
 *    deliberately not MEDIUM, so a rollback that fell back to the creation
 *    default is distinguishable from a correct one); a refused FIRST SET
 *    restores `null` rather than the value the server just rejected. Coercing
 *    the resolved value with `|| "MEDIUM"` makes that case red.
 *
 * WHAT IT DOES **NOT** PROVE. These pass against the pre-ISS-9665 hook too. The
 * `UNSET_PRIORITY` sentinel this PR threads through `useCommitLedger` is a
 * TYPE-level accommodation — the ledger stores values opaquely and compares
 * them by identity, so `null` already round-tripped through it unharmed at
 * runtime. So this is a forward regression guard on an uncovered contract, not
 * a counterfactual for the sentinel; do not read it as one.
 *
 * `commit` is the surface's own callback, so asserting on the object it
 * receives IS asserting the request the row makes — the hook has no other way
 * to reach the API.
 */
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import type { ArtifactStatus, Document } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ArtifactRowEditInput } from "../use-artifact-row-edit";
import { useArtifactRowEdit } from "../use-artifact-row-edit";

const ARTIFACT_ID = "11111111-1111-1111-1111-111111111111";

const commit = vi.fn<(input: ArtifactRowEditInput) => Promise<unknown>>();

beforeEach(() => {
  commit.mockReset();
  commit.mockResolvedValue({});
});

describe("useArtifactRowEdit priority clearing (ISS-9665)", () => {
  test("reports an unset priority as null, not as the folded MEDIUM", () => {
    const { result } = renderHook(() =>
      useArtifactRowEdit(buildArtifact(null), { commit })
    );

    expect(result.current.priority).toBeNull();
  });

  test("commits a CLEAR as priority: null — not an empty string, not an omitted key", async () => {
    const { result } = renderHook(() =>
      useArtifactRowEdit(buildArtifact(Priority.High), { commit })
    );

    await act(async () => {
      result.current.onPriorityChange?.(null);
      // Settle the commit promise inside `act`, so the ledger has applied
      // its outcome — the value, or a refused write's rollback — before the
      // assertions read it.
      await Promise.resolve();
    });

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    // Whole-object equality: the `""` ledger sentinel must NOT escape into the
    // request, and the key must be present — an omitted `priority` is "leave it
    // alone", the opposite of the request the user just made.
    expect(commit).toHaveBeenCalledWith({
      id: ARTIFACT_ID,
      priority: null,
      // ISS-9443: the row names its own surface, so the telemetry event can be
      // attributed without the API guessing where the write came from.
      surface: ArtifactStatusEditSurface.InlineCell,
    });
    expect(result.current.priority).toBeNull();
  });

  test("a REFUSED clear restores the priority the artifact actually had", async () => {
    commit.mockRejectedValue(new Error("server said no"));
    const { result } = renderHook(() =>
      useArtifactRowEdit(buildArtifact(Priority.Urgent), { commit })
    );

    await act(async () => {
      result.current.onPriorityChange?.(null);
      // Settle the commit promise inside `act`, so the ledger has applied
      // its outcome — the value, or a refused write's rollback — before the
      // assertions read it.
      await Promise.resolve();
    });

    // URGENT, deliberately not MEDIUM: a rollback that fell back to the
    // creation default — the value the old serializer fabricated — is the
    // failure this pins, and it is indistinguishable from a correct one on a
    // MEDIUM fixture.
    await waitFor(() => expect(result.current.priority).toBe(Priority.Urgent));
  });

  test("a REFUSED first set rolls back to UNSET, not to the value that was refused", async () => {
    commit.mockRejectedValue(new Error("server said no"));
    const { result } = renderHook(() =>
      useArtifactRowEdit(buildArtifact(null), { commit })
    );

    await act(async () => {
      result.current.onPriorityChange?.(Priority.Low);
      // Settle the commit promise inside `act`, so the ledger has applied
      // its outcome — the value, or a refused write's rollback — before the
      // assertions read it.
      await Promise.resolve();
    });

    // `toBeNull`, not a falsy check: `""` here would mean the ledger sentinel
    // leaked into the rendered value, and the cell would render an empty
    // priority glyph rather than the "No priority" treatment.
    await waitFor(() => expect(result.current.priority).toBeNull());
  });

  test("still sets a real priority, and reports it, on an artifact that had none", async () => {
    const { result } = renderHook(() =>
      useArtifactRowEdit(buildArtifact(null), { commit })
    );

    await act(async () => {
      result.current.onPriorityChange?.(Priority.High);
      // Settle the commit promise inside `act`, so the ledger has applied
      // its outcome — the value, or a refused write's rollback — before the
      // assertions read it.
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(commit).toHaveBeenCalledWith({
        id: ARTIFACT_ID,
        priority: Priority.High,
        surface: ArtifactStatusEditSurface.InlineCell,
      })
    );
    expect(result.current.priority).toBe(Priority.High);
  });

  test("an authoritative refetch to unset replaces an optimistic priority", () => {
    // The parent handing down a NEW artifact is authoritative — another user's
    // edit, or this row's own refetch. A ledger that kept its optimistic value
    // would leave the row showing a priority the server no longer reports.
    const { result, rerender } = renderHook(
      ({ artifact }: { artifact: Document }) =>
        useArtifactRowEdit(artifact, { commit }),
      { initialProps: { artifact: buildArtifact(Priority.High) } }
    );

    expect(result.current.priority).toBe(Priority.High);

    rerender({ artifact: buildArtifact(null) });

    expect(result.current.priority).toBeNull();
  });
});

function buildArtifact(priority: Priority | null): Document {
  return {
    id: ARTIFACT_ID,
    organizationId: "22222222-2222-2222-2222-222222222222",
    projectId: null,
    title: "An artifact",
    type: DocumentType.Prd,
    slug: "PRD-1",
    fileName: null,
    status: DocumentStatus.Draft as ArtifactStatus,
    priority,
    latestVersion: 1,
    createdById: "33333333-3333-3333-3333-333333333333",
    createdBy: null,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    dueDate: null,
    sortOrder: null,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-02T00:00:00.000Z"),
  } as Document;
}
