"use client";

import {
  type GridSelectionModifiers,
  reconcileGridRowSelection,
  resolveGridRowSelection,
  selectAllGridRows,
  toggleGridRowSelection,
} from "@repo/design-system/lib/grid-table-v2-selection";
import {
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type { GenericArtifact } from "../fixtures";
import { clearSelection } from "./artifact-list-bulk-actions";

type SelectionOptions = Readonly<{
  displayedArtifacts: readonly GenericArtifact[];
  selectedArtifactIds: ReadonlySet<string>;
  selectionAnchorId: RefObject<string | null>;
  setSelectedArtifactIds: Dispatch<SetStateAction<Set<string>>>;
}>;

/** Bridges the shared grid's rendered-row selection contract to this list's state. */
export function useArtifactListGridSelection({
  displayedArtifacts,
  selectedArtifactIds,
  selectionAnchorId,
  setSelectedArtifactIds,
}: SelectionOptions) {
  const listResultsRef = useRef<HTMLDivElement>(null);

  const handleArtifactSelection = (
    artifact: GenericArtifact,
    event: GridSelectionModifiers,
    renderedRowIds: readonly string[]
  ) => {
    const anchorId = selectionAnchorId.current;
    setSelectedArtifactIds(
      (current) =>
        resolveGridRowSelection(
          { anchorId, selectedIds: current },
          artifact.id,
          event,
          renderedRowIds
        ).selectedIds as Set<string>
    );
    selectionAnchorId.current =
      event.shiftKey && anchorId && renderedRowIds.includes(anchorId)
        ? anchorId
        : artifact.id;
  };
  const handleArtifactRowClick = (
    artifact: GenericArtifact,
    event: MouseEvent<HTMLDivElement>,
    renderedRows: readonly GenericArtifact[]
  ) =>
    handleArtifactSelection(
      artifact,
      event,
      renderedRows.map((row) => row.id)
    );
  const handleArtifactRowKeyboardNavigate = (
    artifact: GenericArtifact,
    event: KeyboardEvent<HTMLDivElement>,
    renderedRows: readonly GenericArtifact[]
  ) =>
    handleArtifactSelection(
      artifact,
      event,
      renderedRows.map((row) => row.id)
    );
  const toggleArtifactSelection = (artifact: GenericArtifact) => {
    setSelectedArtifactIds(
      (current) =>
        toggleGridRowSelection(
          { anchorId: selectionAnchorId.current, selectedIds: current },
          artifact.id
        ).selectedIds as Set<string>
    );
    selectionAnchorId.current = artifact.id;
  };
  const selectAllVisibleArtifacts = (rows: readonly GenericArtifact[]) => {
    const selection = selectAllGridRows(rows.map((row) => row.id));
    setSelectedArtifactIds(selection.selectedIds as Set<string>);
    selectionAnchorId.current = selection.anchorId;
  };
  const reconcileSelection = useCallback(
    (rows: readonly GenericArtifact[]) => {
      const selection = reconcileGridRowSelection(
        {
          anchorId: selectionAnchorId.current,
          selectedIds: selectedArtifactIds,
        },
        rows.map((row) => row.id)
      );
      selectionAnchorId.current = selection.anchorId;
      if (selection.selectedIds !== selectedArtifactIds) {
        setSelectedArtifactIds(new Set(selection.selectedIds));
      }
    },
    [selectedArtifactIds, selectionAnchorId, setSelectedArtifactIds]
  );

  // The grid owns bare Space and select-all. Shift+Space and Escape remain a
  // host-scoped shortcut, after the focused cell and any entered control have
  // had first refusal; only painted rows are eligible for the range.
  const handleSelectionKeyDown = (event: globalThis.KeyboardEvent) => {
    const results = listResultsRef.current;
    if (
      event.defaultPrevented ||
      !(event.target instanceof HTMLElement) ||
      !event.target.matches("[data-grid-cell]") ||
      !results?.contains(event.target)
    ) {
      return;
    }
    if (event.key === "Escape" && selectedArtifactIds.size > 0) {
      event.preventDefault();
      clearSelection(setSelectedArtifactIds, selectionAnchorId);
      return;
    }
    if (
      event.key !== " " ||
      !event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    const artifactId =
      event.target.closest<HTMLElement>("[data-grid-row]")?.dataset.gridRowId;
    const artifact = displayedArtifacts.find((row) => row.id === artifactId);
    if (!artifact) {
      return;
    }
    event.preventDefault();
    const renderedRowIds = [
      ...results.querySelectorAll<HTMLElement>("[data-grid-row]"),
    ].flatMap((row) => row.dataset.gridRowId ?? []);
    handleArtifactSelection(artifact, event, renderedRowIds);
  };
  useEffect(() => {
    globalThis.window.addEventListener("keydown", handleSelectionKeyDown);
    return () =>
      globalThis.window.removeEventListener("keydown", handleSelectionKeyDown);
  });

  return {
    handleArtifactRowClick,
    handleArtifactRowRangeDrag: (
      artifact: GenericArtifact,
      modifiers: GridSelectionModifiers,
      rows: readonly GenericArtifact[]
    ) =>
      handleArtifactSelection(
        artifact,
        modifiers,
        rows.map((row) => row.id)
      ),
    handleArtifactRowKeyboardNavigate,
    listResultsRef,
    reconcileSelection,
    selectAllVisibleArtifacts,
    toggleArtifactSelection,
  };
}
