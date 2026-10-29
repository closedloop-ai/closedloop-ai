// @vitest-environment jsdom

import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { genericArtifacts } from "../../fixtures";
import {
  type ArtifactListColumnExtension,
  columnWidthBounds,
} from "../artifact-list-model";
import { GenericArtifactListShell } from "../artifact-shells";

/** A column the user may never hide; `resolveColumnLayout` always renders it. */
const UNHIDEABLE_COLUMN: ArtifactListColumnExtension = {
  hideable: false,
  id: "pinned",
  kind: ColumnFieldKind.Custom,
  label: "Pinned",
  renderCell: () => null,
  width: columnWidthBounds(120),
};

/** A column that declares it starts hidden. */
const DEFAULT_HIDDEN_COLUMN: ArtifactListColumnExtension = {
  defaultHidden: true,
  id: "startsHidden",
  kind: ColumnFieldKind.Custom,
  label: "Starts hidden",
  renderCell: () => null,
  width: columnWidthBounds(120),
};

/** A column that declares its move and resize capabilities away. */
const LOCKED_COLUMN: ArtifactListColumnExtension = {
  id: "locked",
  kind: ColumnFieldKind.Custom,
  label: "Locked",
  movable: false,
  renderCell: () => null,
  resizable: false,
  sortable: true,
  width: columnWidthBounds(120),
};

const LOCKED_RESIZE_HANDLE = /^Resize Locked column,/;
const OWNER_RESIZE_HANDLE = /^Resize Owner column,/;
const RELATED_SESSIONS_RESIZE_HANDLE = /^Resize Related Sessions column,/;
const COMMENTS_MENU_ITEM = /^Comments/;
const OWNER_MENU_ITEM = /^Owner/;
const PINNED_MENU_ITEM = /^Pinned/;
const RUNNING_READ_ONLY_STATUS = /In progress, Running.*Set automatically/i;

function openColumnMenu(columnLabel: string): void {
  fireEvent.pointerDown(
    screen.getByLabelText(`${columnLabel} column options`),
    {
      button: 0,
      ctrlKey: false,
    }
  );
}

/**
 * ISS-9315: the generic artifact list is the web-master prototype's Gridview
 * surface, and its columns, tracks, order and widths now come out of the
 * design-system column registry in one resolution rather than four hand-built
 * derivations beside each other.
 *
 * The expectations below are written as literals on purpose: reading them back
 * off `genericArtifactColumns` or off `resolveColumnLayout` would keep passing
 * if a column were dropped, re-widthed or re-ordered.
 */

/**
 * The DATA column ids the grid actually painted, in rendered order. The fixed
 * leading identity column is not one of them.
 */
function renderedColumnIds(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="columnheader"][data-column-id]'
    ),
  ]
    .map((header) => header.dataset.columnId ?? "")
    .filter((columnId) => columnId !== "__leading__");
}

/** The CSS grid tracks the header row is painted against. */
function headerTrackString(): string {
  const headerRow = document
    .querySelector('[role="columnheader"][data-column-id]')
    ?.closest<HTMLElement>("[style*='grid-template-columns']");
  return headerRow?.style.gridTemplateColumns ?? "";
}

describe("generic artifact list columns", () => {
  beforeEach(() => {
    // The shell mirrors its view state into the URL, and jsdom keeps that URL
    // across tests in a file — so without this each case restores the previous
    // case's `columns=` selection instead of its own default.
    window.history.replaceState({}, "", "/");
  });

  it("keeps the shared artifact host outside the closed pointer rollout", () => {
    const { container } = render(
      <GenericArtifactListShell
        artifacts={genericArtifacts}
        onOpenArtifact={() => undefined}
      />
    );

    expect(
      container.querySelector("[data-grid-interaction-contract]")
    ).toBeNull();
    const firstArtifact = genericArtifacts[0];
    if (!firstArtifact) {
      throw new Error("generic artifact fixture is empty");
    }
    const editAction = screen.getByRole("button", {
      name: `Edit artifact name for ${firstArtifact.slug}`,
    });
    expect(editAction).toHaveClass(
      "opacity-0",
      "transition-opacity",
      "focus-visible:opacity-100",
      "group-hover/lead:opacity-100"
    );
    expect(editAction).not.toHaveClass(
      "group-hover/row:opacity-100",
      "group-focus-within/row:opacity-100",
      "[@media(pointer:coarse)]:opacity-100",
      "transition-[opacity,background-color,color]"
    );
  });

  it("paints one track per visible column at the width that column declares", () => {
    render(
      <GenericArtifactListShell
        artifacts={genericArtifacts}
        defaultVisibleColumnIds={[
          "owner",
          "status",
          "relatedSessions",
          "comments",
        ]}
        onOpenArtifact={() => undefined}
      />
    );

    expect(renderedColumnIds()).toEqual([
      "owner",
      "status",
      "relatedSessions",
      "comments",
    ]);
    // 36px favourites rail + 280px artifact lead, then owner/status/
    // relatedSessions/comments at their declared 130/304/220/100, then the 40px
    // Add-field slot. Related Sessions holds the 220px RS-018 froze.
    expect(headerTrackString()).toBe("36px 280px 130px 304px 220px 100px 40px");
  });

  it("keeps the full read-only status inside the fixed-height row at its supported minimum", () => {
    render(
      <GenericArtifactListShell
        artifacts={genericArtifacts}
        defaultVisibleColumnIds={["status"]}
        onOpenArtifact={() => undefined}
      />
    );

    expect(headerTrackString()).toBe("36px 280px 304px 40px");
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();

    const running = screen.getByLabelText(RUNNING_READ_ONLY_STATUS);
    expect(running.textContent).toContain("In progress");
    expect(running.textContent).toContain("Running");
    expect(running.textContent).toContain(
      "Set automatically, so it cannot be changed here."
    );
    expect(running.classList.contains("flex-col")).toBe(true);
    expect(running.classList.contains("flex-wrap")).toBe(false);
    expect(
      screen
        .getByText("Set automatically, so it cannot be changed here.")
        .classList.contains("whitespace-nowrap")
    ).toBe(true);
  });

  it("drops a hidden column's track along with its header", () => {
    render(
      <GenericArtifactListShell
        artifacts={genericArtifacts}
        defaultVisibleColumnIds={["owner", "comments"]}
        onOpenArtifact={() => undefined}
      />
    );

    expect(renderedColumnIds()).toEqual(["owner", "comments"]);
    expect(headerTrackString()).toBe("36px 280px 130px 100px 40px");
  });

  it("moves a column one RENDERED position when its neighbouring slot is hidden", async () => {
    // The declared order is owner, collaborators, status, relatedSessions,
    // comments, updated, currentVersion, tags — so `tags` and `status` are four
    // hidden slots apart in the complete order and adjacent on screen.
    render(
      <GenericArtifactListShell
        artifacts={genericArtifacts}
        defaultVisibleColumnIds={["owner", "status", "tags"]}
        onOpenArtifact={() => undefined}
      />
    );
    expect(renderedColumnIds()).toEqual(["owner", "status", "tags"]);

    openColumnMenu("Tags");
    fireEvent.keyDown(await screen.findByText("Move column"), { key: "Enter" });
    fireEvent.click(await screen.findByText("Move left"));

    expect(renderedColumnIds()).toEqual(["owner", "tags", "status"]);
  });

  it("gives a re-shown column back its own remembered slot, not the end", async () => {
    render(
      <GenericArtifactListShell
        artifacts={genericArtifacts}
        defaultVisibleColumnIds={["owner", "status", "tags"]}
        onOpenArtifact={() => undefined}
      />
    );

    openColumnMenu("Tags");
    fireEvent.keyDown(await screen.findByText("Move column"), { key: "Enter" });
    fireEvent.click(await screen.findByText("Move left"));
    expect(renderedColumnIds()).toEqual(["owner", "tags", "status"]);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Options" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: COMMENTS_MENU_ITEM })
    );

    // `comments` was declared between `relatedSessions` and `updated`, so it
    // comes back ahead of the `status` the move pushed to the end — which only
    // holds because the move was merged onto the complete order rather than
    // overwriting it.
    expect(renderedColumnIds()).toEqual([
      "owner",
      "tags",
      "comments",
      "status",
    ]);
  });

  it("withholds move and resize from a column that declares them away", async () => {
    render(
      <GenericArtifactListShell
        additionalColumns={[LOCKED_COLUMN]}
        artifacts={genericArtifacts}
        defaultVisibleColumnIds={["owner", "locked"]}
        onOpenArtifact={() => undefined}
      />
    );
    expect(renderedColumnIds()).toEqual(["owner", "locked"]);

    expect(screen.queryByLabelText(LOCKED_RESIZE_HANDLE)).toBeNull();
    expect(screen.getByLabelText(OWNER_RESIZE_HANDLE)).toBeTruthy();

    openColumnMenu("Locked");
    // The menu really opened — so the absent Move item below is a withheld
    // capability, not an unopened menu.
    expect(await screen.findByText("Sort ascending")).toBeTruthy();
    expect(screen.queryByText("Move column")).toBeNull();

    openColumnMenu("Owner");
    expect(await screen.findByText("Move column")).toBeTruthy();
  });

  /**
   * whitlockk review: the case above proves the MECHANISM on a column invented to
   * declare its capabilities away, which leaves the real declarations unpinned
   * — flipping `resizable: false` onto Related Sessions kept this whole file
   * green while the preserved baseline says the column must stay resizable.
   * Asserted against the shipped declaration, not a fixture's.
   */
  it("keeps Related Sessions resizable, as its preserved baseline declares", () => {
    render(
      <GenericArtifactListShell
        artifacts={genericArtifacts}
        defaultVisibleColumnIds={["owner", "relatedSessions"]}
        onOpenArtifact={() => undefined}
      />
    );

    expect(renderedColumnIds()).toEqual(["owner", "relatedSessions"]);
    expect(screen.getByLabelText(RELATED_SESSIONS_RESIZE_HANDLE)).toBeTruthy();
  });

  /**
   * whitlockk review: the Options menu listed every column, so a `hideable: false`
   * column got a switch reporting UNCHECKED while `resolveColumnLayout` kept it
   * on screen — a control for a state it cannot reach.
   */
  it("offers no visibility switch for a column that cannot be hidden", async () => {
    render(
      <GenericArtifactListShell
        additionalColumns={[UNHIDEABLE_COLUMN]}
        artifacts={genericArtifacts}
        defaultVisibleColumnIds={["owner", "pinned"]}
        onOpenArtifact={() => undefined}
      />
    );
    expect(renderedColumnIds()).toEqual(["owner", "pinned"]);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Options" }), {
      button: 0,
      ctrlKey: false,
    });
    // The menu really opened, so the absent Pinned row below is a withheld
    // control rather than an unopened menu.
    expect(
      await screen.findByRole("menuitem", { name: OWNER_MENU_ITEM })
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: PINNED_MENU_ITEM })
    ).toBeNull();
  });

  /**
   * whitlockk review: the shell seeded visibility from every configured id, which
   * started a `defaultHidden: true` column VISIBLE — the inverse of what it
   * declares.
   */
  it("starts a defaultHidden column hidden", () => {
    render(
      <GenericArtifactListShell
        additionalColumns={[DEFAULT_HIDDEN_COLUMN]}
        artifacts={genericArtifacts}
        onOpenArtifact={() => undefined}
      />
    );

    expect(renderedColumnIds()).not.toContain("startsHidden");
  });
});
