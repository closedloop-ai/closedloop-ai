import { type RenderResult, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { vi } from "vitest";
import { type GenericArtifact, genericArtifacts } from "../../../fixtures";
import type { ArtifactHierarchySpec } from "../../artifact-hierarchy-view";
import type { GenericArtifactListShellProps } from "../../artifact-list-model";
import { GenericArtifactListShell } from "../../artifact-shells";

/** Each case mounts the whole list shell, which is slow under a loaded jsdom lane. */
export const SHELL_FLOW_TIMEOUT_MS = 30_000;

export const EDIT_NAME_PREFIX = "Edit artifact name for ";
export const OWNER_COLUMN_OPTIONS = "Owner column options";
export const LIST_VIEW = "List view";
export const BOARD_VIEW = "Board view";
export const LAST_7_DAYS = "Last 7 days";
export const ADD_FIELD = "Add field";
export const ADD_ARTIFACT = "Add artifact";
export const CREATE_ARTIFACT_DIALOG = "Create artifact";
export const FILTER_MENU_ITEM = "Filter";
export const FIRST_ARTIFACT_TITLE = genericArtifacts[0]?.title ?? "";

export type ShellOverrides = Partial<
  Omit<GenericArtifactListShellProps, "hierarchy" | "manualOrdering">
> &
  (
    | { hierarchy: ArtifactHierarchySpec; manualOrdering?: boolean }
    | { hierarchy?: undefined; manualOrdering?: false }
  );

/** Mounts the list shell over the preview fixtures, with per-case overrides. */
export function renderShell(props: ShellOverrides = {}): RenderResult {
  if (props.manualOrdering) {
    return render(<ControlledManualShell {...props} />);
  }
  return render(
    <GenericArtifactListShell
      artifacts={genericArtifacts}
      onOpenArtifact={vi.fn()}
      {...props}
    />
  );
}

function ControlledManualShell(props: ShellOverrides) {
  const [artifacts, setArtifacts] = useState(() => [
    ...(props.artifacts ?? genericArtifacts),
  ]);
  const onArtifactsChange = useCallback(
    (nextArtifacts: readonly GenericArtifact[]) =>
      setArtifacts([...nextArtifacts]),
    []
  );
  return (
    <GenericArtifactListShell
      {...props}
      artifacts={artifacts}
      controlledArtifacts
      onArtifactsChange={onArtifactsChange}
      onOpenArtifact={props.onOpenArtifact ?? vi.fn()}
    />
  );
}

/** Slugs of the rows the grid painted, in painted order. */
export function rowSlugs(): string[] {
  return screen
    .queryAllByRole("button", {
      name: (name) => name.startsWith(EDIT_NAME_PREFIX),
    })
    .map((button) =>
      (button.getAttribute("aria-label") ?? "").slice(EDIT_NAME_PREFIX.length)
    );
}

/** The element at `index`, or a failure naming what was missing. */
export function nthElement(
  elements: readonly HTMLElement[],
  index: number
): HTMLElement {
  const element = elements[index];
  if (!element) {
    throw new Error(`expected an element at index ${index}`);
  }
  return element;
}
