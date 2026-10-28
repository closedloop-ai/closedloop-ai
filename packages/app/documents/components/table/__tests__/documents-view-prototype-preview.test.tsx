import { ARTIFACT_PLACEMENT_MOVED_MESSAGE } from "@repo/app/projects/lib/artifact-placement-copy";
import { MANUAL_REORDER_HANDLE_NAME_PATTERN } from "@repo/app/shared/lib/manual-reorder-handle-label";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { genericArtifacts } from "../../../../shared/components/generic-artifact-surface/preview/fixtures";
import { DocumentsViewPrototypePreview } from "../documents-view-prototype-preview";

describe("DocumentsViewPrototypePreview", () => {
  it("moves rendered rows through the production provider and placement route", async () => {
    const user = userEvent.setup();
    const project = {
      id: "00000000-0000-4000-8000-000000000725",
      code: "PRO-725",
      name: "Manual ordering",
      completionPercentage: 50,
      childTaskCount: 2,
      priority: null,
      owner: null,
      dueDateLabel: null,
      dueDateMs: null,
      updatedLabel: "Today",
      updatedAtMs: Date.UTC(2026, 9, 19),
    };

    render(
      <DocumentsViewPrototypePreview
        artifacts={genericArtifacts.slice(0, 2)}
        navigationAdapter={
          createMemoryNavigation({ initialPath: "/projects/PRO-725" }).adapter
        }
        project={project}
      />
    );

    const handles = await screen.findAllByRole("button", {
      name: MANUAL_REORDER_HANDLE_NAME_PATTERN,
    });
    expect(handles.map((handle) => handle.getAttribute("aria-label"))).toEqual(
      genericArtifacts
        .slice(0, 2)
        .map((artifact) => `Drag to reorder ${artifact.slug}`)
    );
    expect(rowTitle(handles[0])).toContain(genericArtifacts[0]?.title ?? "");
    expect(rowTitle(handles[1])).toContain(genericArtifacts[1]?.title ?? "");

    handles[0]?.focus();
    await user.keyboard("{Control>}{ArrowDown}{/Control}");

    await waitFor(() => {
      const reordered = screen.getAllByRole("button", {
        name: MANUAL_REORDER_HANDLE_NAME_PATTERN,
      });
      expect(rowTitle(reordered[0])).toContain(
        genericArtifacts[1]?.title ?? ""
      );
      expect(rowTitle(reordered[1])).toContain(
        genericArtifacts[0]?.title ?? ""
      );
    });
    expect(
      screen.queryByText(ARTIFACT_PLACEMENT_MOVED_MESSAGE)
    ).toBeInTheDocument();
  });
});

function rowTitle(handle: HTMLElement | undefined): string {
  if (!handle) {
    return "";
  }
  const row = handle.closest('[role="row"]');
  return row?.textContent ?? "";
}
