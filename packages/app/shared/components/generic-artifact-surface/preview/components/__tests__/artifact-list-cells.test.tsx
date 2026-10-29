// @vitest-environment jsdom

import { GridInteractionContract } from "@repo/design-system/components/ui/grid-interaction-contract";
import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { genericArtifacts } from "../../fixtures";
import {
  EditableArtifactLead,
  GenericArtifactCard,
  renderGenericArtifactCell,
} from "../artifact-list-cells";
import {
  type ArtifactListColumnExtension,
  columnWidthBounds,
} from "../artifact-list-model";

const artifact = genericArtifacts[0]!;
const EDIT_NAME = `Edit artifact name for ${artifact.slug}`;

function renderLead(openHref?: string, narrow = false) {
  const onCommit = vi.fn();
  const onOpenArtifact = vi.fn();
  render(
    <EditableArtifactLead
      artifact={artifact}
      narrow={narrow}
      onCommit={onCommit}
      onOpenArtifact={onOpenArtifact}
      openHref={openHref}
    />
  );
  return { onCommit, onOpenArtifact };
}

function startEditing(): HTMLInputElement {
  fireEvent.click(screen.getByRole("button", { name: EDIT_NAME }));
  return screen.getByRole<HTMLInputElement>("textbox", { name: EDIT_NAME });
}

describe("EditableArtifactLead", () => {
  it("opens the artifact in place and links to the resolved or placeholder href", () => {
    const { onOpenArtifact } = renderLead("/artifacts/1");
    const link = screen.getByRole("link");

    expect(link).toHaveAttribute("href", "/artifacts/1");
    expect(fireEvent.click(link)).toBe(false);
    expect(onOpenArtifact).toHaveBeenCalledWith(artifact);
  });

  it("starts renaming without activating the surrounding row", () => {
    const { onOpenArtifact } = renderLead();
    expect(startEditing()).toHaveFocus();
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it("uses a placeholder href when none is resolved", () => {
    renderLead();
    expect(screen.getByRole("link")).toHaveAttribute("href", "#");
  });

  it("AC-025: keeps the narrow pencil pointer-inert while hidden", () => {
    renderLead(undefined, true);

    const pencil = screen.getByRole("button", { name: EDIT_NAME });
    expect(pencil).toHaveClass(
      "pointer-events-none",
      "group-hover/lead:pointer-events-auto",
      "focus-visible:pointer-events-auto"
    );
    expect(screen.getByText(artifact.title)).toHaveClass("truncate");
    expect(startEditing()).toHaveFocus();
  });

  it("keeps the wide pencil in the flex row", () => {
    renderLead();
    expect(screen.getByText(artifact.title)).toHaveClass("truncate");
    expect(screen.getByRole("button", { name: EDIT_NAME })).toHaveClass("ml-1");
    expect(screen.getByRole("button", { name: EDIT_NAME })).not.toHaveClass(
      "absolute"
    );
    expect(screen.getByRole("button", { name: EDIT_NAME })).not.toHaveClass(
      "pointer-events-none"
    );
  });

  it("focuses and selects the title when editing starts", () => {
    renderLead();
    const input = startEditing();

    expect(input).toHaveFocus();
    expect(input.value).toBe(artifact.title);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(artifact.title.length);
  });

  it("commits on Enter and advances to a new row", () => {
    const { onCommit } = renderLead();
    const input = startEditing();

    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledWith(artifact.id, "Renamed", {
      advanceToNewRow: true,
    });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("commits on blur without advancing", () => {
    const { onCommit } = renderLead();
    const input = startEditing();

    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith(artifact.id, "Blurred", {
      advanceToNewRow: false,
    });
  });

  it("discards the draft on Escape and on a blank commit", () => {
    const { onCommit } = renderLead();

    fireEvent.change(startEditing(), { target: { value: "Throwaway" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(startEditing().value).toBe(artifact.title);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(startEditing().value).toBe(artifact.title);
  });
});

const extensionColumn: ArtifactListColumnExtension = {
  id: "extra",
  kind: ColumnFieldKind.Custom,
  label: "Extra",
  renderCell: (row) => `${row.slug} extra`,
  width: columnWidthBounds(120),
};

const silentExtension: ArtifactListColumnExtension = {
  ...extensionColumn,
  id: "updated",
  label: "Updated",
  renderCell: () => null,
};

function renderCard(selected: boolean, editable = false) {
  const onSelectedChange = vi.fn();
  const onOpenArtifact = vi.fn();
  const { container } = render(
    <GenericArtifactCard
      additionalColumns={[extensionColumn, silentExtension]}
      artifact={artifact}
      columns={[
        { id: "extra", label: "Extra" },
        { id: "updated", label: "Updated" },
        { id: "unknown", label: "Unknown" },
      ]}
      customFields={[]}
      favorited={false}
      onFavoriteChange={vi.fn()}
      onOpenArtifact={onOpenArtifact}
      onSelectedChange={onSelectedChange}
      referenceArtifacts={genericArtifacts}
      renderLead={
        editable
          ? (row) => (
              <EditableArtifactLead
                artifact={row}
                onCommit={vi.fn()}
                onOpenArtifact={onOpenArtifact}
              />
            )
          : undefined
      }
      selected={selected}
    />
  );
  const card = container.firstElementChild as HTMLElement;
  return { card, onOpenArtifact, onSelectedChange };
}

describe("GenericArtifactCard", () => {
  it("renders extension cells, falls back to generic cells, and leaves unknown columns empty", () => {
    const { card } = renderCard(false);

    expect(card).toHaveTextContent(
      `Extra${artifact.slug} extraUpdated${artifact.updated}Unknown`
    );
    expect(card).not.toHaveAttribute("data-state");
  });

  it("toggles selection from the card body but not from its controls", () => {
    const { card, onOpenArtifact, onSelectedChange } = renderCard(true);

    expect(card).toHaveAttribute("data-state", "selected");
    fireEvent.click(screen.getByText("Extra"));
    expect(onSelectedChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText(artifact.title));
    expect(onOpenArtifact).toHaveBeenCalledWith(artifact);
    expect(onSelectedChange).toHaveBeenCalledTimes(1);
  });

  it("marks its card utility as contextual only when a contract composes the card", () => {
    const { rerender } = render(
      <GenericArtifactCard
        additionalColumns={[]}
        artifact={artifact}
        columns={[]}
        customFields={[]}
        favorited={false}
        onFavoriteChange={vi.fn()}
        onOpenArtifact={vi.fn()}
        onSelectedChange={vi.fn()}
        referenceArtifacts={genericArtifacts}
        selected={false}
      />
    );
    const legacyAction = screen.getByRole("button", {
      name: `Add ${artifact.title} to favorites`,
    });
    const legacyActionWrapper = legacyAction.closest(
      "[data-grid-contextual-action]"
    );
    expect(legacyActionWrapper).not.toBeNull();
    expect(
      legacyActionWrapper?.closest(
        '[data-grid-interaction-contract="pointer-hover"]'
      )
    ).toBeNull();

    rerender(
      <GridInteractionContract>
        <GenericArtifactCard
          additionalColumns={[]}
          artifact={artifact}
          columns={[]}
          customFields={[]}
          favorited={false}
          onFavoriteChange={vi.fn()}
          onOpenArtifact={vi.fn()}
          onSelectedChange={vi.fn()}
          referenceArtifacts={genericArtifacts}
          selected={false}
        />
      </GridInteractionContract>
    );
    expect(
      screen
        .getByRole("button", {
          name: `Add ${artifact.title} to favorites`,
        })
        .closest("[data-grid-contextual-action]")
        ?.closest('[data-grid-interaction-contract="pointer-hover"]')
    ).not.toBeNull();
  });
});
describe("renderGenericArtifactCell", () => {
  it("renders a matching custom field before any built-in column", () => {
    render(
      renderGenericArtifactCell(
        "updated",
        artifact,
        [{ id: "updated", label: "Notes", type: "Text" }],
        genericArtifacts
      )
    );

    expect(screen.queryByText(artifact.updated)).toBeNull();
    expect(screen.getByLabelText("Edit Notes")).toBeInTheDocument();
  });
});
