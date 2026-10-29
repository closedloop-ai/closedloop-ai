import {
  PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS,
  ProjectArtifactLanePolicyReason,
} from "@repo/api/src/types/project-artifact-lane-policy";
import type { ArtifactBoardItem } from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { ArtifactBoardMutationState } from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectArtifactBoard,
  ProjectArtifactBoardField,
  projectArtifactBoardPolicyFeedback,
} from "./project-artifact-board";
import { orderProjectBoardLanes } from "./project-artifact-board-model";

const LANE_HEADER_PATTERN = /^(Done|Todo)$/;

const items: readonly ArtifactBoardItem[] = [
  {
    fieldValues: { owner: "Ada", priority: "high", status: "Todo" },
    id: "todo-root",
    laneId: "todo",
    parentId: null,
    rootId: "todo-root",
    slug: "ISS-1",
    title: "Visible root",
    typeLabel: "Issue",
  },
  {
    fieldValues: { owner: "Grace", priority: "low", status: "Done" },
    id: "done-root",
    laneId: "done",
    parentId: null,
    rootId: "done-root",
    slug: "ISS-2",
    title: "Collapsed root",
    typeLabel: "Issue",
  },
];

describe("CT-09 AC-004 persisted Project board rendering", () => {
  it("renders persisted lane order, collapse, and card fields together", () => {
    const lanes = orderProjectBoardLanes(
      [
        { id: "todo", label: "Todo", rootIds: ["todo-root"] },
        { id: "done", label: "Done", rootIds: ["done-root"] },
      ],
      ["done", "todo"]
    ).map((lane) => ({ ...lane, collapsed: lane.id === "done" }));

    render(
      <ProjectArtifactBoard
        feedback={{ state: ArtifactBoardMutationState.Idle }}
        getDropTargetLabel={(target) => target.laneId}
        groupBy={ProjectArtifactBoardField.Status}
        items={items}
        lanes={lanes}
        onMove={vi.fn()}
        onOpen={vi.fn()}
        onSelectionChange={vi.fn()}
        selectedIds={[]}
        visibleFieldIds={[ProjectArtifactBoardField.Owner]}
      />
    );

    expect(
      screen
        .getAllByText(LANE_HEADER_PATTERN, { selector: "span" })
        .map((element) => element.textContent)
    ).toEqual(["Done", "Todo"]);
    expect(screen.queryByText("Collapsed root")).not.toBeInTheDocument();
    expect(screen.getByText("Visible root")).toBeVisible();
    expect(
      document.querySelector('[data-artifact-board-field="owner"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-artifact-board-field="priority"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-artifact-board-field="status"]')
    ).toBeNull();
  });
});

describe("CT-18 AC-002/AC-004 Project board policy feedback", () => {
  it("renders WIP capacity refusal through the existing accessible alert", () => {
    render(
      <ProjectArtifactBoard
        feedback={projectArtifactBoardPolicyFeedback(
          ProjectArtifactLanePolicyReason.WipLimitReached
        )}
        getDropTargetLabel={(target) => target.laneId}
        groupBy={ProjectArtifactBoardField.Status}
        items={items}
        lanes={[{ id: "todo", label: "Todo", rootIds: ["todo-root"] }]}
        onMove={vi.fn()}
        onOpen={vi.fn()}
        onSelectionChange={vi.fn()}
        selectedIds={[]}
        visibleFieldIds={[ProjectArtifactBoardField.Owner]}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS[
        ProjectArtifactLanePolicyReason.WipLimitReached
      ]
    );
  });
});
