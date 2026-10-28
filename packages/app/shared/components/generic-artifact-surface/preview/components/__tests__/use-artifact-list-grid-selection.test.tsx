import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { genericArtifacts } from "../../fixtures";
import { useArtifactListGridSelection } from "../use-artifact-list-grid-selection";

const FIRST = genericArtifacts[0]!;
const SECOND = genericArtifacts[1]!;

describe("artifact list selection reconciliation", () => {
  it("does not write a fresh Set when every selected row remains visible", () => {
    const setSelectedArtifactIds = vi.fn();
    const selectionAnchorId = createRef<string | null>();
    selectionAnchorId.current = FIRST.id;
    const { result } = renderHook(() =>
      useArtifactListGridSelection({
        displayedArtifacts: [FIRST, SECOND],
        selectedArtifactIds: new Set([FIRST.id]),
        selectionAnchorId,
        setSelectedArtifactIds,
      })
    );

    act(() => result.current.reconcileSelection([FIRST, SECOND]));

    expect(setSelectedArtifactIds).not.toHaveBeenCalled();
    expect(selectionAnchorId.current).toBe(FIRST.id);
  });

  it("updates the anchor outside the state updater and writes only surviving ids", () => {
    const setSelectedArtifactIds = vi.fn();
    const selectionAnchorId = createRef<string | null>();
    selectionAnchorId.current = FIRST.id;
    const { result } = renderHook(() =>
      useArtifactListGridSelection({
        displayedArtifacts: [FIRST, SECOND],
        selectedArtifactIds: new Set([FIRST.id, SECOND.id]),
        selectionAnchorId,
        setSelectedArtifactIds,
      })
    );

    act(() => result.current.reconcileSelection([SECOND]));

    expect(selectionAnchorId.current).toBeNull();
    expect(setSelectedArtifactIds).toHaveBeenCalledTimes(1);
    const written = setSelectedArtifactIds.mock.calls[0]?.[0];
    expect(written).toBeInstanceOf(Set);
    expect([...(written as Set<string>)]).toEqual([SECOND.id]);
  });
});
