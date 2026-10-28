// @vitest-environment jsdom

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ARTIFACT_STATUS_UNKNOWN_TOOLTIP } from "@repo/api/src/types/artifact-status-display";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ArtifactKind, ArtifactStatus, genericArtifacts } from "../../fixtures";
import { ArtifactStatusBoard } from "../artifact-status-board";

const STATUS_REFUSAL = /cannot be changed here/i;

describe("ArtifactStatusBoard authority", () => {
  it("does not repeat status on a card when status is the secondary grouping", () => {
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Issue
    )!;
    render(
      <ArtifactStatusBoard
        config={{ editable: true }}
        defaultKind={ArtifactKind.Issue}
        groupBy="owner"
        groups={[
          {
            items: [issue],
            key: issue.owner,
            label: issue.owner,
            subgroups: [
              {
                items: [issue],
                key: ARTIFACT_STATUS_ROOT.Todo,
                label: "Todo",
              },
            ],
          },
        ]}
        noun={{ plural: "artifacts", singular: "artifact" }}
        onGroupDrop={vi.fn()}
        onOpen={vi.fn()}
        onStatusChange={vi.fn()}
        secondaryGroupBy="status"
      />
    );

    const card = screen.getByText(issue.title).closest("[draggable]");
    expect(card).toBeTruthy();
    expect(card).not.toHaveTextContent("Todo");
    expect(screen.getByText("Todo")).toBeInTheDocument();
  });

  it("keeps provider- and runtime-owned rows read-only in a mixed board", async () => {
    const user = userEvent.setup();
    const branch = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Branch
    )!;
    const session = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Session
    )!;
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Issue
    )!;
    const onStatusChange = vi.fn();
    render(
      <ArtifactStatusBoard
        config={{ editable: true }}
        defaultKind={ArtifactKind.Issue}
        groupBy="status"
        groups={[
          {
            items: [branch, session, issue],
            key: ARTIFACT_STATUS_ROOT.InProgress,
            label: "In progress",
          },
        ]}
        noun={{ plural: "artifacts", singular: "artifact" }}
        onGroupDrop={vi.fn()}
        onOpen={vi.fn()}
        onStatusChange={onStatusChange}
        secondaryGroupBy="none"
      />
    );

    expect(
      screen.getByText(branch.title).closest("[draggable]")
    ).toHaveAttribute("draggable", "false");
    expect(
      screen.getByText(session.title).closest("[draggable]")
    ).toHaveAttribute("draggable", "false");
    expect(
      screen.getByText(issue.title).closest("[draggable]")
    ).toHaveAttribute("draggable", "true");

    await user.click(
      screen.getByRole("button", { name: `Actions for ${branch.title}` })
    );
    expect(screen.getByRole("menuitem")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("keeps an unknown row read-only and gates its explanation", async () => {
    const user = userEvent.setup();
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Issue
    )!;
    const unknown = {
      ...issue,
      id: "unknown-issue",
      statusRaw: "FUTURE_STATUS",
      title: "Unknown issue status",
    };
    const board = (
      <ArtifactStatusBoard
        config={{ editable: true }}
        defaultKind={ArtifactKind.Issue}
        groupBy="owner"
        groups={[
          {
            items: [unknown],
            key: unknown.owner,
            label: unknown.owner,
          },
        ]}
        noun={{ plural: "artifacts", singular: "artifact" }}
        onGroupDrop={vi.fn()}
        onOpen={vi.fn()}
        onStatusChange={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    const { unmount } = render(board);

    expect(screen.queryByTitle(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Actions for Unknown issue status" })
    );
    expect(screen.getByRole("menuitem")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByText(STATUS_REFUSAL)).toBeInTheDocument();

    unmount();
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY],
        })}
      >
        {board}
      </FeatureFlagAdapterProvider>
    );
    expect(screen.getByTitle(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).toBeVisible();
  });

  it("accepts dragover while transfer reads are protected and resolves on drop", () => {
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Issue
    )!;
    const onGroupDrop = vi.fn();
    const stored = new Map<string, string>();
    let protectedMode = true;
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) =>
        protectedMode ? "" : (stored.get(type) ?? ""),
      setData: (type: string, value: string) => stored.set(type, value),
    };
    const { container } = render(
      <ArtifactStatusBoard
        config={{ editable: true }}
        defaultKind={ArtifactKind.Issue}
        groupBy="status"
        groups={[
          {
            items: [issue],
            key: ARTIFACT_STATUS_ROOT.InReview,
            label: "In review",
          },
        ]}
        noun={{ plural: "artifacts", singular: "artifact" }}
        onGroupDrop={onGroupDrop}
        onOpen={vi.fn()}
        onStatusChange={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    const row = screen.getByText(issue.title).closest("[draggable]")!;
    const cell = container.querySelector<HTMLElement>(
      '[data-status-board-cell="in_review/"]'
    )!;

    fireEvent.dragStart(row, { dataTransfer });
    expect(fireEvent.dragOver(cell, { dataTransfer })).toBe(false);
    protectedMode = false;
    fireEvent.drop(cell, { dataTransfer });

    expect(onGroupDrop).toHaveBeenCalledWith(
      issue.id,
      "status",
      ARTIFACT_STATUS_ROOT.InReview,
      undefined,
      undefined
    );
  });

  it("refuses a status lane the dragged kind cannot resolve", () => {
    const document = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Document
    )!;
    const onGroupDrop = vi.fn();
    const stored = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => stored.get(type) ?? "",
      setData: (type: string, value: string) => stored.set(type, value),
    };
    const { container } = render(
      <ArtifactStatusBoard
        config={{ editable: true }}
        defaultKind={ArtifactKind.Document}
        groupBy="status"
        groups={[
          {
            items: [document],
            key: ARTIFACT_STATUS_ROOT.Todo,
            label: "Todo",
          },
        ]}
        noun={{ plural: "artifacts", singular: "artifact" }}
        onGroupDrop={onGroupDrop}
        onOpen={vi.fn()}
        onStatusChange={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    const row = screen.getByText(document.title).closest("[draggable]")!;
    const cell = container.querySelector<HTMLElement>(
      '[data-status-board-cell="todo/"]'
    )!;

    fireEvent.dragStart(row, { dataTransfer });
    expect(fireEvent.dragOver(cell, { dataTransfer })).toBe(true);
    fireEvent.drop(cell, { dataTransfer });

    expect(dataTransfer.dropEffect).toBe("none");
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("does not offer a Document Done drop or creation that would imply Approved", () => {
    const document = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Document
    )!;
    const draftDocument = {
      ...document,
      status: ArtifactStatus.Draft,
    };
    const onGroupDrop = vi.fn();
    const onAdd = vi.fn();
    const stored = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => stored.get(type) ?? "",
      setData: (type: string, value: string) => stored.set(type, value),
    };
    const { container } = render(
      <ArtifactStatusBoard
        config={{ editable: true }}
        defaultKind={ArtifactKind.Document}
        groupBy="status"
        groups={[
          {
            items: [draftDocument],
            key: ARTIFACT_STATUS_ROOT.InProgress,
            label: "In progress",
          },
          {
            items: [],
            key: ARTIFACT_STATUS_ROOT.InReview,
            label: "In review",
          },
          {
            items: [],
            key: ARTIFACT_STATUS_ROOT.Done,
            label: "Done",
          },
        ]}
        noun={{ plural: "documents", singular: "document" }}
        onAdd={onAdd}
        onGroupDrop={onGroupDrop}
        onOpen={vi.fn()}
        onStatusChange={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    const row = screen.getByText(document.title).closest("[draggable]")!;
    const doneCell = container.querySelector<HTMLElement>(
      '[data-status-board-cell="done/"]'
    )!;

    fireEvent.dragStart(row, { dataTransfer });
    expect(fireEvent.dragOver(doneCell, { dataTransfer })).toBe(true);
    fireEvent.drop(doneCell, { dataTransfer });
    expect(onGroupDrop).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("button", { name: "Add document" })
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Add document" }));
    expect(onAdd).toHaveBeenCalledWith(ArtifactStatus.InReview);
  });

  it("refuses an owner band the shared group mutation cannot map", () => {
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Issue
    )!;
    const onGroupDrop = vi.fn();
    const stored = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => stored.get(type) ?? "",
      setData: (type: string, value: string) => stored.set(type, value),
    };
    const { container } = render(
      <ArtifactStatusBoard
        config={{ editable: true }}
        defaultKind={ArtifactKind.Issue}
        groupBy="owner"
        groups={[
          {
            items: [issue],
            key: "No value",
            label: "Unassigned",
          },
        ]}
        noun={{ plural: "artifacts", singular: "artifact" }}
        onGroupDrop={onGroupDrop}
        onOpen={vi.fn()}
        onStatusChange={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    const row = screen.getByText(issue.title).closest("[draggable]")!;
    const cell = container.querySelector<HTMLElement>(
      '[data-status-board-cell="No value/"]'
    )!;

    fireEvent.dragStart(row, { dataTransfer });
    expect(fireEvent.dragOver(cell, { dataTransfer })).toBe(true);
    fireEvent.drop(cell, { dataTransfer });

    expect(dataTransfer.dropEffect).toBe("none");
    expect(onGroupDrop).not.toHaveBeenCalled();
  });
});
