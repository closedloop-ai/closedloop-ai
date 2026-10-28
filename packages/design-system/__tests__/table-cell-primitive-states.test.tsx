import {
  TableChoiceListCell,
  TableReferenceListCell,
} from "@closedloop-ai/design-system/components/ui/table-cell-list-primitives";
import {
  TableCellValueState,
  TableChangeCell,
  TableChoiceCell,
  TableCountCell,
  TableFavoriteCell,
  TableTextCell,
} from "@closedloop-ai/design-system/components/ui/table-cell-primitives";
import {
  TableModelCell,
  TablePriority,
  TablePriorityCell,
  TableRepositoryCell,
} from "@closedloop-ai/design-system/components/ui/table-cell-semantic-primitives";
import { TooltipProvider } from "@closedloop-ai/design-system/components/ui/tooltip";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileTextIcon, MessageSquareIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

const EM_DASH = "—";

function renderCell(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("table cell value states", () => {
  it("renders loading as busy placeholder without leaking stale content", () => {
    renderCell(
      <TableTextCell
        loadingLabel="Loading title"
        state={TableCellValueState.Loading}
        value="Cached title"
      />
    );

    const loadingValue = screen.getByRole("status");

    expect(loadingValue).toHaveAttribute("aria-busy", "true");
    expect(loadingValue).toHaveAttribute(
      "data-cell-value-state",
      TableCellValueState.Loading
    );
    expect(loadingValue).toHaveTextContent("Loading title");
    expect(screen.queryByText("Cached title")).toBeNull();
  });

  it("renders error as a named status without leaking stale content", () => {
    renderCell(
      <TableTextCell
        errorLabel="Title failed to load"
        state={TableCellValueState.Error}
        value="Cached title"
      />
    );

    expect(
      screen.getByRole("status", { name: "Title failed to load" })
    ).toHaveAttribute("data-cell-value-state", TableCellValueState.Error);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.queryByText("Cached title")).toBeNull();
  });

  it.each([
    [TableCellValueState.Unavailable, "Cell value unavailable", "Unavailable"],
    [TableCellValueState.Forbidden, "Cell value restricted", "Restricted"],
    [TableCellValueState.Partial, "Partial cell value", "Partial"],
  ])(
    "renders %s as a distinct unavailable-data state",
    (state, accessibleName, visibleLabel) => {
      renderCell(<TableTextCell state={state} value="Cached title" />);

      expect(screen.getByLabelText(accessibleName)).toHaveAttribute(
        "data-cell-value-state",
        state
      );
      expect(screen.getByText(visibleLabel)).toBeInTheDocument();
      expect(screen.queryByText("Cached title")).toBeNull();
    }
  );

  it("keeps empty values on the shared empty sentinel", () => {
    renderCell(<TableTextCell value="" />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
    expect(screen.getByText(EM_DASH)).not.toHaveAttribute(
      "data-cell-value-state"
    );
  });

  it.each([
    ["text", () => <TableTextCell disabled focusVisible selected value="" />],
    [
      "choice list",
      () => <TableChoiceListCell choices={[]} disabled focusVisible selected />,
    ],
    [
      "priority",
      () => (
        <TablePriorityCell disabled focusVisible priority={null} selected />
      ),
    ],
  ])(
    "keeps interaction-state attributes on empty %s values",
    (_label, build) => {
      renderCell(build());

      const emptyValue = screen.getByText(EM_DASH);

      expect(emptyValue).toHaveAttribute("aria-disabled", "true");
      expect(emptyValue).toHaveAttribute("data-cell-disabled", "true");
      expect(emptyValue).toHaveAttribute("data-cell-focus-visible", "true");
      expect(emptyValue).toHaveAttribute("data-cell-selected", "true");
      expect(emptyValue.className).toContain("ring-2");
      expect(emptyValue).not.toHaveAttribute("data-cell-value-state");
    }
  );

  it("keeps interaction-state attributes on explicit value states", () => {
    renderCell(
      <TableTextCell
        disabled
        focusVisible
        loadingLabel="Loading title"
        selected
        state={TableCellValueState.Loading}
        value="Cached title"
      />
    );

    const loadingValue = screen.getByRole("status");

    expect(loadingValue).toHaveAttribute("aria-disabled", "true");
    expect(loadingValue).toHaveAttribute("data-cell-disabled", "true");
    expect(loadingValue).toHaveAttribute("data-cell-focus-visible", "true");
    expect(loadingValue).toHaveAttribute("data-cell-selected", "true");
    expect(loadingValue.className).toContain("ring-2");
  });
});

describe("table cell interaction states", () => {
  it("marks selected, focus-visible, and disabled state at the primitive boundary", () => {
    renderCell(
      <TableChoiceCell disabled focusVisible label="Approved" selected />
    );

    const chip = screen.getByText("Approved").closest("[data-slot='chip']");
    if (!chip) {
      throw new Error("Expected the choice label to render inside a chip.");
    }

    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).toHaveAttribute("data-cell-disabled", "true");
    expect(chip).toHaveAttribute("data-cell-focus-visible", "true");
    expect(chip).toHaveAttribute("data-cell-selected", "true");
    expect(chip.className).toContain("ring-2");
  });

  it("keeps disabled favorite actions from reporting a change", () => {
    const onFavoriteChange = vi.fn();
    renderCell(
      <TableFavoriteCell
        disabled
        favorited={false}
        itemLabel="ISS-1"
        onFavoriteChange={onFavoriteChange}
      />
    );

    const button = screen.getByRole("button", {
      name: "Add ISS-1 to favorites",
    });
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(onFavoriteChange).not.toHaveBeenCalled();
  });

  it("keeps disabled repository actions from reporting a selection", () => {
    const onSelect = vi.fn();
    renderCell(
      <TableRepositoryCell disabled label="closedloop-ai" onSelect={onSelect} />
    );

    const button = screen.getByRole("button", {
      name: "Open closedloop-ai repository",
    });
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("table cell list and semantic state reuse", () => {
  it("uses the shared value-state renderer for list primitives", () => {
    renderCell(
      <TableChoiceListCell
        choices={[{ id: "ready", label: "Ready" }]}
        state={TableCellValueState.Forbidden}
      />
    );

    expect(screen.getByLabelText("Cell value restricted")).toHaveAttribute(
      "data-cell-value-state",
      TableCellValueState.Forbidden
    );
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("measures list cells after a transient value state clears", async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const previousResizeObserver = Object.getOwnPropertyDescriptor(
      globalThis,
      "ResizeObserver"
    );
    class StubResizeObserver implements ResizeObserver {
      disconnect(): void {
        disconnect();
      }

      observe(): void {
        observe();
      }

      unobserve(): void {
        return;
      }
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: StubResizeObserver,
      writable: true,
    });

    try {
      const choices = [
        { id: "ready", label: "Ready" },
        { id: "review", label: "Review" },
        { id: "merged", label: "Merged" },
      ];
      const { rerender } = renderCell(
        <TableChoiceListCell
          choices={choices}
          loadingLabel="Loading choices"
          state={TableCellValueState.Loading}
        />
      );

      expect(observe).not.toHaveBeenCalled();

      rerender(
        <TooltipProvider>
          <TableChoiceListCell choices={choices} />
        </TooltipProvider>
      );

      await waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      if (previousResizeObserver) {
        Object.defineProperty(
          globalThis,
          "ResizeObserver",
          previousResizeObserver
        );
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("renders disabled references without invoking their action", () => {
    const onSelect = vi.fn();
    renderCell(
      <TableReferenceListCell
        disabled
        references={[
          {
            icon: FileTextIcon,
            id: "doc-1",
            label: "DOC-1",
            onSelect,
          },
        ]}
      />
    );

    expect(
      screen.queryByRole("button", { name: "DOC-1" })
    ).not.toBeInTheDocument();

    const [referenceChip] = screen.getAllByTitle("DOC-1");
    if (!referenceChip) {
      throw new Error("Expected a disabled reference chip.");
    }
    fireEvent.click(referenceChip);

    expect(referenceChip).toHaveAttribute("aria-disabled", "true");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders the action and no destination when a reference carries both arms", () => {
    const onSelect = vi.fn();
    renderCell(
      <TableReferenceListCell
        references={[
          // `TableReference` forbids both arms, so this literal is reachable
          // only from an untyped caller — the directive is the type-level half
          // of the contract and the render below is the runtime half.
          // @ts-expect-error - href and onSelect are mutually exclusive
          {
            href: "/artifacts/DOC-1",
            icon: FileTextIcon,
            id: "doc-1",
            label: "DOC-1",
            onSelect,
          },
        ]}
      />
    );

    expect(screen.getByRole("button", { name: "DOC-1" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "DOC-1" })
    ).not.toBeInTheDocument();
  });

  it("keeps the label proportional whenever the chip carries an avatar", () => {
    renderCell(
      <TableReferenceListCell
        references={[
          {
            avatarUrl: "data:image/svg+xml,%3Csvg/%3E",
            id: "picture-only",
            label: "1:40 PM",
          },
        ]}
      />
    );

    const [pictureOnly] = screen.getAllByTitle("1:40 PM");
    if (!pictureOnly) {
      throw new Error("Expected a picture-only reference chip.");
    }

    // The mono treatment marks the identifier variant, which is the branch
    // WITHOUT an avatar. A picture-only chip renders the avatar pill, so a
    // mono label here would sit beside a proportional one in the same column.
    expect(pictureOnly).toHaveClass("rounded-full");
    expect(pictureOnly.querySelector(".font-mono")).toBeNull();
  });

  // A real bug (caught reviewing the Storybook Playground control, not by an
  // existing test): Radix's `Avatar.Root` caches `imageLoadingStatus` in
  // context, and `AvatarImage` only reports a status change while mounted.
  // Conditionally UNMOUNTING `AvatarImage` once `avatarUrl` disappears (the
  // previous code here) left the Root believing "loaded" forever, so
  // `AvatarFallback` — which renders only while status !== "loaded" — never
  // came back. The chip went completely empty instead of falling back to
  // initials. `AvatarImage` must stay mounted with a possibly-undefined `src`
  // so its own effect can report the fresh "error" status that un-hides the
  // fallback.
  it("falls back to initials when a loaded avatar disappears on rerender", () => {
    const previousImage = globalThis.Image;
    // jsdom's real Image never reports `complete`/`naturalWidth` (it does no
    // actual decoding), which is exactly why this bug survived — nothing here
    // ever reached the "loaded" state to regress FROM. This stub simulates a
    // picture that decodes instantly, the same as a small inline data URI does
    // in a real browser.
    class InstantlyDecodedImage {
      complete = true;
      naturalWidth = 1;
      src = "";
      addEventListener(): void {
        return;
      }
      removeEventListener(): void {
        return;
      }
    }
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      value: InstantlyDecodedImage,
      writable: true,
    });

    try {
      const reference = {
        avatarUrl: "data:image/svg+xml,%3Csvg/%3E",
        id: "avery",
        initials: "AE",
        label: "1:40 PM",
      };
      const { rerender } = renderCell(
        <TableReferenceListCell references={[reference]} />
      );

      // The picture "loaded": the fallback initials stay hidden.
      expect(screen.queryByText("AE")).not.toBeInTheDocument();

      rerender(
        <TooltipProvider>
          <TableReferenceListCell
            references={[{ ...reference, avatarUrl: undefined }]}
          />
        </TooltipProvider>
      );

      const [initials] = screen.getAllByText("A");
      expect(initials).toBeInTheDocument();
    } finally {
      Object.defineProperty(globalThis, "Image", {
        configurable: true,
        value: previousImage,
        writable: true,
      });
    }
  });

  it("carries an explicit empty reason on an empty reference list", () => {
    renderCell(
      <TableReferenceListCell
        emptyTitle="No related sessions"
        references={[]}
      />
    );

    expect(screen.getByTitle("No related sessions")).toHaveAttribute(
      "data-slot",
      "grid-empty-value"
    );
  });

  it("marks semantic primitives with the same interaction-state attributes", () => {
    renderCell(<TablePriorityCell priority={TablePriority.High} selected />);

    const priorityCell = screen
      .getByText("High")
      .closest("[data-cell-selected='true']");
    if (!priorityCell) {
      throw new Error("Expected priority state attributes on the cell root.");
    }

    expect(priorityCell).toBeInTheDocument();
  });

  it("removes disabled model cells from the tab sequence", () => {
    const { container } = renderCell(
      <TableModelCell disabled model="claude-opus-4-6" />
    );

    const chip = container.querySelector("[data-slot='chip']");
    if (!chip) {
      throw new Error("Expected the model label to render inside a chip.");
    }

    expect(screen.getByText("claude-opus-4-6")).toBeInTheDocument();
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).not.toHaveAttribute("tabindex");
  });
});

describe("table cell numeric guardrails", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "surfaces invalid count %s as an error state",
    (count) => {
      renderCell(<TableCountCell count={count} icon={MessageSquareIcon} />);

      expect(
        screen.getByRole("status", { name: "Invalid count" })
      ).toHaveAttribute("data-cell-value-state", TableCellValueState.Error);
      expect(screen.queryByText(EM_DASH)).toBeNull();
    }
  );

  it("does not format invalid change counts as real values", () => {
    renderCell(
      <TableChangeCell
        additions={Number.NaN}
        deletions={Number.POSITIVE_INFINITY}
      />
    );

    expect(
      screen.getByRole("status", { name: "Invalid change count" })
    ).toHaveAttribute("data-cell-value-state", TableCellValueState.Error);
    expect(screen.queryByText(EM_DASH)).toBeNull();
    expect(screen.queryByText("+NaN")).toBeNull();
    expect(screen.queryByText("∞")).toBeNull();
  });

  it("keeps the valid side of a paired change count without zero-filling an invalid side", () => {
    renderCell(<TableChangeCell additions={Number.NaN} deletions={4} />);

    expect(
      screen.getByLabelText("additions unavailable, 4 deletions")
    ).toBeInTheDocument();
    expect(screen.getByText("−4")).toBeInTheDocument();
    expect(screen.queryByText("+NaN")).toBeNull();
  });
});
