// @vitest-environment jsdom

/**
 * ISS-10480. `tsc` is the gate for the two `@ts-expect-error` cases, never
 * `vitest run`, which strips the directive. Each supported declaration beside
 * them is its control: because the declaration without `manualOrdering`
 * compiles, the refusal is attributable to the pairing and not to a forgotten
 * prop.
 *
 * The rendering cases pin the other half of the gate, `manualOrdering &&
 * !sortActive`, including the sorted contract `project-hierarchy-spec.ts`
 * states: remove the handles, never leave a disabled one.
 */

import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { type GenericArtifact, genericArtifacts } from "../../fixtures";
import type { ArtifactHierarchySpec } from "../artifact-hierarchy-view";
import type { GenericArtifactListShellProps } from "../artifact-list-model";
import { GenericArtifactListShell } from "../artifact-shells";

const template = genericArtifacts[0]!;
const hierarchy: ArtifactHierarchySpec = { maxVisibleLevels: 4 };

function artifact(id: string): GenericArtifact {
  return {
    ...template,
    id,
    parentArtifactId: null,
    slug: id.toUpperCase(),
    title: id,
  };
}

/** A spec a caller only has on some routes, as `ArtifactHierarchySpec | undefined`. */
function hierarchySpecWhen(
  enabled: boolean
): ArtifactHierarchySpec | undefined {
  return enabled ? hierarchy : undefined;
}

/** The reorder handles rendered inside `container`, in painted row order. */
function reorderHandleLabels(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>("[data-grid-row-drag-handle]"),
  ].map((handle) => handle.getAttribute("aria-label") ?? "");
}

describe("artifact list manual ordering", () => {
  beforeEach(() => {
    // The shell mirrors its view state into the URL, which jsdom keeps across
    // cases in a file.
    globalThis.window.history.replaceState({}, "", "/");
  });

  it("makes manual ordering without a hierarchy spec a typecheck error", () => {
    const supported: GenericArtifactListShellProps = {
      artifacts: genericArtifacts,
      hierarchy,
      manualOrdering: true,
      onOpenArtifact: () => undefined,
    };
    const flat: GenericArtifactListShellProps = {
      artifacts: genericArtifacts,
      manualOrdering: false,
      onOpenArtifact: () => undefined,
    };
    // @ts-expect-error — ISS-10480: the shell has no flat row source.
    const refused: GenericArtifactListShellProps = {
      artifacts: genericArtifacts,
      manualOrdering: true,
      onOpenArtifact: () => undefined,
    };

    expect(supported.manualOrdering).toBe(true);
    expect(flat.manualOrdering).toBe(false);
    expect(refused.manualOrdering).toBe(true);
  });

  it("still accepts a conditionally computed hierarchy spec", () => {
    // Computed through a function so the declared optional type survives:
    // `const x: Spec | undefined = hierarchy` is narrowed to `Spec` by control
    // flow, which would make the refusal below untestable.
    const optionalSpec = hierarchySpecWhen(true);
    // The property union splits across the arms: the spec branch matches the
    // hierarchy arm and the `undefined` branch matches the flat one, so a
    // caller that computes the spec conditionally still compiles.
    const conditional: GenericArtifactListShellProps = {
      artifacts: genericArtifacts,
      hierarchy: optionalSpec,
      onOpenArtifact: () => undefined,
    };
    // Only the combination ISS-10480 exists to forbid is refused: a spec that
    // may be absent cannot also ask for manual ordering.
    // @ts-expect-error — ISS-10480: no arm pairs a maybe-absent spec with it.
    const refusedWithOrdering: GenericArtifactListShellProps = {
      artifacts: genericArtifacts,
      hierarchy: optionalSpec,
      manualOrdering: true,
      onOpenArtifact: () => undefined,
    };

    expect(conditional.hierarchy).toBe(hierarchy);
    expect(refusedWithOrdering.manualOrdering).toBe(true);
  });

  it("renders a reorder handle per row and moves the row it belongs to", async () => {
    function ControlledManualOrdering() {
      const [artifacts, setArtifacts] = useState<GenericArtifact[]>([
        artifact("first"),
        artifact("second"),
      ]);
      return (
        <GenericArtifactListShell
          artifacts={artifacts}
          controlledArtifacts
          hierarchy={hierarchy}
          manualOrdering
          onArtifactsChange={(nextArtifacts) =>
            setArtifacts([...nextArtifacts])
          }
          onOpenArtifact={() => undefined}
        />
      );
    }
    const { container } = render(<ControlledManualOrdering />);

    expect(reorderHandleLabels(container)).toEqual([
      "Drag to reorder FIRST",
      "Drag to reorder SECOND",
    ]);
    expect(
      container.querySelector("[data-grid-interaction-contract]")
    ).toBeNull();
    const handles = container.querySelectorAll<HTMLElement>(
      "[data-grid-row-drag-handle]"
    );
    expect(handles).toHaveLength(2);
    const firstHandle = handles[0];
    expect(firstHandle).not.toBeNull();
    expect(firstHandle).toHaveClass(
      "opacity-0",
      "transition-colors",
      "focus-visible:cursor-default",
      "focus-visible:text-foreground",
      "focus-visible:opacity-100",
      "focus-visible:outline-none",
      "focus-visible:ring-ring",
      "focus-visible:ring-inset",
      "disabled:cursor-not-allowed",
      "disabled:opacity-30",
      "group-hover:opacity-100"
    );
    for (const handle of handles) {
      expect(handle).toHaveClass("touch-none");
      expect(handle).toHaveClass("touch:opacity-100");
      expect(handle).toHaveClass("focus-visible:ring-offset-2");
      expect(handle).toHaveClass("focus-visible:ring-offset-background");
      for (const focusClass of CHIP_FOCUS_RING_CLASS.split(" ")) {
        expect(handle).toHaveClass(focusClass);
      }
    }

    fireEvent.keyDown(handles[0] as Element, {
      key: "ArrowDown",
      metaKey: true,
    });

    await waitFor(() =>
      expect(reorderHandleLabels(container)).toEqual([
        "Drag to reorder SECOND",
        "Drag to reorder FIRST",
      ])
    );
  });

  it("renders no reorder handle while manual ordering is off", () => {
    const { container } = render(
      <GenericArtifactListShell
        artifacts={[artifact("first"), artifact("second")]}
        hierarchy={hierarchy}
        onOpenArtifact={() => undefined}
      />
    );

    expect(reorderHandleLabels(container)).toEqual([]);
  });

  it("removes the handles while a sort is applied rather than disabling them", () => {
    globalThis.window.history.replaceState({}, "", "/?sort=name&direction=asc");

    const { container } = render(
      <GenericArtifactListShell
        artifacts={[artifact("first"), artifact("second")]}
        hierarchy={hierarchy}
        manualOrdering
        onOpenArtifact={() => undefined}
      />
    );

    expect(reorderHandleLabels(container)).toEqual([]);
  });
});
