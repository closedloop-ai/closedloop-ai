// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditableMultiSelectCell,
  EditableOwnerCell,
  EditableSingleSelectCell,
} from "../artifact-list-custom-cells";
import { EDITABLE_OWNERS } from "../artifact-list-owners";
import { openRadixMenu } from "./support/radix-menu";
import {
  runLastToastUndo,
  type ToastSuccessHandler,
} from "./support/toast-spy";

const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<ToastSuccessHandler>(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: toastSuccess },
}));

const FIELD_UPDATED = "Field updated";
const SINGLE_LABEL = "Team";
const EMPTY_SLOT = '[data-slot="grid-empty-value"]';
const MULTI_LABEL = "Areas";
const OPTIONS = ["Alpha", "Beta", "Gamma"];
const OPTION_COLORS = ["bg-red-500", "bg-blue-500"];
const [firstOwner, secondOwner, thirdOwner] = EDITABLE_OWNERS;

/**
 * An owner as the cell draws them: one initial on every avatar (Nerys,
 * 2026-10-22), so a stored "AE" draws "A", then the name.
 */
function drawnOwner(owner: (typeof EDITABLE_OWNERS)[number]): string {
  return `${owner.initials.charAt(0)}${owner.name}`;
}

beforeEach(() => {
  toastSuccess.mockReset();
});

/**
 * ISS-9351 routes every adapter write through the shared cell's serialized
 * commit queue, so `onChange` and the toast land a microtask after the click
 * rather than during it. Asserting without draining the queue passes for a
 * cell that simply had not got there yet.
 */
async function flushCommitQueue() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("EditableOwnerCell", () => {
  function renderOwner(onChange = vi.fn()) {
    const result = render(
      <EditableOwnerCell
        initialInitials={firstOwner.initials}
        initialOwner={firstOwner.name}
        onChange={onChange}
      />
    );
    return { onChange, result };
  }

  it("names and draws the current owner", () => {
    renderOwner();

    expect(
      screen.getByRole("button", {
        name: `Edit owner, currently ${firstOwner.name}`,
      })
    ).toHaveTextContent(drawnOwner(firstOwner));
  });

  it("lists every editable owner with the current one checked", () => {
    renderOwner();
    openRadixMenu(
      screen.getByRole("button", {
        name: `Edit owner, currently ${firstOwner.name}`,
      })
    );

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.textContent)).toEqual(
      EDITABLE_OWNERS.map(drawnOwner)
    );
    expect(
      screen.getByRole("menuitemradio", {
        name: drawnOwner(firstOwner),
      })
    ).toHaveAttribute("aria-checked", "true");
  });

  it("reassigns, toasts, and undoes back to the previous owner", async () => {
    const { onChange } = renderOwner();
    openRadixMenu(
      screen.getByRole("button", {
        name: `Edit owner, currently ${firstOwner.name}`,
      })
    );

    fireEvent.click(
      screen.getByRole("menuitemradio", {
        name: drawnOwner(thirdOwner),
      })
    );

    await flushCommitQueue();

    expect(onChange).toHaveBeenLastCalledWith({
      owner: thirdOwner.name,
      ownerInitials: thirdOwner.initials,
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Owner updated",
      expect.anything()
    );
    expect(
      screen.getByRole("button", {
        name: `Edit owner, currently ${thirdOwner.name}`,
      })
    ).toBeInTheDocument();

    runLastToastUndo(toastSuccess);
    await flushCommitQueue();

    expect(onChange).toHaveBeenLastCalledWith({
      owner: firstOwner.name,
      ownerInitials: firstOwner.initials,
    });
    expect(
      screen.getByRole("button", {
        name: `Edit owner, currently ${firstOwner.name}`,
      })
    ).toBeInTheDocument();
  });

  it("follows changed initial props", () => {
    const { result } = renderOwner();

    result.rerender(
      <EditableOwnerCell
        initialInitials={secondOwner.initials}
        initialOwner={secondOwner.name}
      />
    );

    expect(
      screen.getByRole("button", {
        name: `Edit owner, currently ${secondOwner.name}`,
      })
    ).toHaveTextContent(drawnOwner(secondOwner));
  });

  it("reassigns without an onChange listener", async () => {
    render(
      <EditableOwnerCell
        initialInitials={firstOwner.initials}
        initialOwner={firstOwner.name}
      />
    );
    openRadixMenu(
      screen.getByRole("button", {
        name: `Edit owner, currently ${firstOwner.name}`,
      })
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", {
        name: drawnOwner(secondOwner),
      })
    );
    await flushCommitQueue();
    runLastToastUndo(toastSuccess);
    await flushCommitQueue();

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `Edit owner, currently ${firstOwner.name}`,
        })
      ).toBeInTheDocument()
    );
  });
});

describe("EditableSingleSelectCell", () => {
  it("renders the empty state without an initial value", () => {
    render(
      <EditableSingleSelectCell
        label={SINGLE_LABEL}
        optionColors={OPTION_COLORS}
        options={OPTIONS}
      />
    );

    // ISS-9351 replaced the prototype-local "+ Add" affordance with the design
    // system's own empty-cell sentinel, so the empty state is pinned on that
    // slot rather than on the old label. Whether the hover-reveal "+ Add"
    // should come back is an open product question on #7787.
    expect(
      screen
        .getByRole("button", { name: `Set ${SINGLE_LABEL}` })
        .querySelector(EMPTY_SLOT)
    ).not.toBeNull();
  });

  it("colours a chip whose option has a colour and leaves the rest outlined", () => {
    render(
      <EditableSingleSelectCell
        initialValue="Alpha"
        label={SINGLE_LABEL}
        optionColors={OPTION_COLORS}
        options={OPTIONS}
      />
    );
    render(
      <EditableSingleSelectCell
        initialValue="Gamma"
        label={SINGLE_LABEL}
        optionColors={OPTION_COLORS}
        options={OPTIONS}
      />
    );

    const alpha = screen.getByRole("button", {
      name: `Edit ${SINGLE_LABEL}, currently Alpha`,
    }).firstElementChild;
    const gamma = screen.getByRole("button", {
      name: `Edit ${SINGLE_LABEL}, currently Gamma`,
    }).firstElementChild;
    expect(alpha).toHaveClass("bg-red-500", "text-white");
    expect(gamma).not.toHaveClass("text-white");
  });

  it("selects a value, toasts, and undoes it", async () => {
    render(
      <EditableSingleSelectCell
        initialValue="Alpha"
        label={SINGLE_LABEL}
        optionColors={OPTION_COLORS}
        options={OPTIONS}
      />
    );
    openRadixMenu(
      screen.getByRole("button", {
        name: `Edit ${SINGLE_LABEL}, currently Alpha`,
      })
    );

    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent)
    ).toEqual(OPTIONS);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Beta" }));
    await flushCommitQueue();

    expect(toastSuccess).toHaveBeenCalledWith(FIELD_UPDATED, expect.anything());
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `Edit ${SINGLE_LABEL}, currently Beta`,
        })
      ).toBeInTheDocument()
    );

    runLastToastUndo(toastSuccess);
    await flushCommitQueue();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `Edit ${SINGLE_LABEL}, currently Alpha`,
        })
      ).toBeInTheDocument()
    );
  });
});

describe("EditableMultiSelectCell", () => {
  it("renders the shared empty-cell sentinel when empty", () => {
    render(
      <EditableMultiSelectCell
        initialValues={[]}
        label={MULTI_LABEL}
        optionColors={OPTION_COLORS}
        options={OPTIONS}
      />
    );

    expect(
      screen
        .getByRole("button", { name: `Set ${MULTI_LABEL}` })
        .querySelector(EMPTY_SLOT)
    ).not.toBeNull();
  });

  it("toggles values while the menu stays open, and undoes each toggle", async () => {
    render(
      <EditableMultiSelectCell
        initialValues={["Alpha"]}
        label={MULTI_LABEL}
        optionColors={OPTION_COLORS}
        options={OPTIONS}
      />
    );
    openRadixMenu(
      screen.getByRole("button", {
        name: `Edit ${MULTI_LABEL}, currently Alpha`,
      })
    );

    expect(
      screen.getByRole("menuitemcheckbox", { name: "Alpha" })
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Gamma" })
    ).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Gamma" }));
    await flushCommitQueue();

    expect(toastSuccess).toHaveBeenCalledWith(FIELD_UPDATED, expect.anything());
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Gamma" })
    ).toHaveAttribute("aria-checked", "true");
    // The open menu hides the rest of the page from the accessibility tree.
    expect(
      screen.getByRole("button", {
        hidden: true,
        name: `Edit ${MULTI_LABEL}, currently Alpha, Gamma`,
      })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Alpha" }));
    await flushCommitQueue();
    expect(
      screen.getByRole("button", {
        hidden: true,
        name: `Edit ${MULTI_LABEL}, currently Gamma`,
      })
    ).toBeInTheDocument();

    runLastToastUndo(toastSuccess);
    await flushCommitQueue();
    expect(
      screen.getByRole("button", {
        hidden: true,
        name: `Edit ${MULTI_LABEL}, currently Alpha, Gamma`,
      })
    ).toBeInTheDocument();
  });
});

function chipsFor(text: string) {
  return screen
    .getAllByText(text)
    .map((node) => node.closest('[data-slot="chip"]'));
}

describe("option colours", () => {
  it("colours only the single-select menu options that declare a colour", () => {
    render(
      <EditableSingleSelectCell
        initialValue="Beta"
        label={SINGLE_LABEL}
        optionColors={OPTION_COLORS}
        options={OPTIONS}
      />
    );
    openRadixMenu(
      screen.getByRole("button", {
        name: `Edit ${SINGLE_LABEL}, currently Beta`,
      })
    );

    const alpha = screen.getByRole("menuitemradio", { name: "Alpha" });
    const gamma = screen.getByRole("menuitemradio", { name: "Gamma" });
    expect(within(alpha).getByText("Alpha")).toHaveClass(
      "bg-red-500",
      "text-white"
    );
    expect(within(gamma).getByText("Gamma")).not.toHaveClass("text-white");
  });

  it("chips a coloured multi-select value and leaves an uncoloured one plain", () => {
    render(
      <EditableMultiSelectCell
        initialValues={["Alpha", "Gamma"]}
        label={MULTI_LABEL}
        optionColors={OPTION_COLORS}
        options={OPTIONS}
      />
    );

    expect(
      screen
        .getByRole("button", {
          name: `Edit ${MULTI_LABEL}, currently Alpha, Gamma`,
        })
        .querySelector(EMPTY_SLOT)
    ).toBeNull();

    // `chipSelectOptions` supplies a chip class only while `optionColors` has
    // an entry, so Gamma — the third option against two colours — is rendered
    // as plain text by the shared cell rather than as an uncoloured chip.
    const alphaChips = chipsFor("Alpha");
    expect(alphaChips.length).toBeGreaterThan(0);
    for (const chip of alphaChips) {
      expect(chip).toHaveClass("bg-red-500", "text-white");
    }
    for (const node of screen.getAllByText("Gamma")) {
      expect(node.closest('[data-slot="chip"]')).toBeNull();
      expect(node).not.toHaveClass("text-white");
    }
  });
});
