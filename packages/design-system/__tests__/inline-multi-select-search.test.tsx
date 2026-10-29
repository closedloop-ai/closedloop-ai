import { InlineMultiSelectCell } from "@closedloop-ai/design-system/components/ui/inline-select-cell";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * PRD-722: the multi-select gains a search box so a long list (an
 * organization's people) stays usable on the champion. Every word is the
 * caller's; two options with different labels pin that the filter narrows to
 * the one typed rather than to the first.
 *
 * ISS-12938 visual QA: a searchable multi-select opens the same Popover and
 * Command picker as the tag and reference cells, so a People column and a
 * Reference column beside it open the same search box (a combobox in a
 * dialog, over a listbox of options) instead of a bordered input in a menu.
 */

const PEOPLE = [
  { value: "ada", label: "Ada Lovelace" },
  { value: "grace", label: "Grace Hopper" },
];

const SEARCH = {
  label: "Search reviewers",
  placeholder: "Type a name",
  emptyMessage: "Nobody by that name",
};

async function flushCommitQueue() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function Controlled({
  initial,
  onCommit,
}: {
  initial: readonly string[];
  onCommit?: (next: readonly string[]) => unknown;
}) {
  const [values, setValues] = useState(initial);
  return (
    <InlineMultiSelectCell
      label="Reviewers"
      onCommit={(next) =>
        Promise.resolve(onCommit?.(next)).then(() => setValues(next))
      }
      options={PEOPLE}
      search={SEARCH}
      values={values}
    />
  );
}

function openPicker(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}

function searchBox(picker: HTMLElement) {
  return within(picker).getByRole("combobox", { name: "Search reviewers" });
}

describe("InlineMultiSelectCell search", () => {
  it("opens a search combobox over a listbox and lands focus in it", async () => {
    render(<Controlled initial={[]} />);
    const picker = openPicker("Set Reviewers");
    const input = searchBox(picker);

    expect(input).toHaveAttribute("placeholder", "Type a name");
    expect(within(picker).getByRole("listbox")).toBeInTheDocument();
    expect(within(picker).queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("narrows the options to the query and says when nothing matches", () => {
    render(<Controlled initial={[]} />);
    const picker = openPicker("Set Reviewers");
    const input = searchBox(picker);

    fireEvent.change(input, { target: { value: "GRACE" } });
    expect(
      within(picker).getByRole("option", { name: "Grace Hopper" })
    ).toBeInTheDocument();
    expect(
      within(picker).queryByRole("option", { name: "Ada Lovelace" })
    ).toBeNull();

    fireEvent.change(input, { target: { value: "zz" } });
    expect(within(picker).getByText("Nobody by that name")).toBeInTheDocument();
  });

  it("keeps typing in the box instead of jumping to a matching option", () => {
    render(<Controlled initial={[]} />);
    const input = searchBox(openPicker("Set Reviewers"));
    input.focus();

    fireEvent.keyDown(input, { key: "g" });

    expect(input).toHaveFocus();
  });

  it("moves with the arrow keys and toggles the highlighted option with Enter", async () => {
    const onCommit = vi.fn();
    render(<Controlled initial={[]} onCommit={onCommit} />);
    const picker = openPicker("Set Reviewers");
    const input = searchBox(picker);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      within(picker).getByRole("option", { name: "Grace Hopper" })
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Enter" });
    await flushCommitQueue();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(["grace"]);
    // The picker stays open across picks, so setting three people is one visit.
    expect(
      within(screen.getByRole("dialog")).getByRole("option", {
        name: "Grace Hopper",
      })
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("button", {
        name: "Edit Reviewers, currently Grace Hopper",
      })
    ).toBeInTheDocument();
  });

  it("commits the whole next set on a click and puts it back when refused", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("refused")));
    render(<Controlled initial={["ada"]} onCommit={onCommit} />);
    const picker = openPicker("Edit Reviewers, currently Ada Lovelace");

    fireEvent.click(
      within(picker).getByRole("option", { name: "Grace Hopper" })
    );
    expect(
      screen.getByRole("button", {
        name: "Edit Reviewers, currently Ada Lovelace, Grace Hopper",
      })
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Edit Reviewers, currently Ada Lovelace",
        })
      ).toBeInTheDocument()
    );
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(["ada", "grace"]);
    expect(
      within(screen.getByRole("dialog")).getByRole("option", {
        name: "Grace Hopper",
      })
    ).toHaveAttribute("aria-checked", "false");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    render(<Controlled initial={[]} />);
    const trigger = screen.getByRole("button", { name: "Set Reviewers" });
    const input = searchBox(openPicker("Set Reviewers"));
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("renders no search box unless the caller asks for one", () => {
    render(
      <InlineMultiSelectCell
        label="Reviewers"
        onCommit={vi.fn()}
        options={PEOPLE}
        values={[]}
      />
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Set Reviewers" }),
      new MouseEvent("pointerdown", { bubbles: true })
    );
    const menu = screen.getByRole("menu");

    expect(within(menu).queryByRole("textbox")).toBeNull();
    expect(within(menu).queryByRole("combobox")).toBeNull();
    expect(
      within(menu).getByRole("menuitemcheckbox", { name: "Grace Hopper" })
    ).toBeInTheDocument();
  });
});
