import { InlineTagCell } from "@closedloop-ai/design-system/components/ui/inline-tag-cell";
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
 * PRD-722 (ISS-9349, ISS-12642): the open-list tag champion.
 *
 * The assertions are about what the CELL SHOWS after a commit settles, never
 * only that `onCommit` was called: every hand-rolled tag editor this replaces
 * also called its handler, and none of them put the previous set back when the
 * write was refused.
 *
 * Every fixture carries two tags with different labels, so "it toggled the one
 * the user picked" is observable.
 */

const OPTIONS = [
  { value: "design", label: "Design" },
  { value: "platform", label: "Platform" },
];

const SEARCH = {
  label: "Search tags",
  placeholder: "Find a tag",
  createLabel: (query: string) => `Make ${query}`,
  emptyMessage: "Nothing yet",
};

async function flushCommitQueue() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderValues(values: readonly string[]) {
  return <span>{values.join(" + ")}</span>;
}

function Controlled({
  initial,
  onCommit,
  onCreate,
}: {
  initial: readonly string[];
  onCommit?: (next: readonly string[]) => unknown;
  onCreate?: (value: string) => void;
}) {
  const [values, setValues] = useState(initial);
  return (
    <InlineTagCell
      label="tags"
      onCommit={(next) => {
        const result = onCommit?.(next);
        return Promise.resolve(result).then(() => setValues(next));
      }}
      onCreate={onCreate}
      options={OPTIONS}
      renderValues={renderValues}
      search={SEARCH}
      values={values}
    />
  );
}

function open(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}

describe("InlineTagCell", () => {
  it("names the trigger for the field and its current set, or the action when empty", () => {
    render(
      <>
        <Controlled initial={["design", "platform"]} />
        <Controlled initial={[]} />
      </>
    );

    expect(
      screen.getByRole("button", {
        name: "Edit tags, currently Design, Platform",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set tags" })
    ).toBeInTheDocument();
  });

  it("toggles the tag the user picked and shows the new set", async () => {
    const onCommit = vi.fn();
    render(<Controlled initial={["design"]} onCommit={onCommit} />);

    const popover = open("Edit tags, currently Design");
    fireEvent.click(within(popover).getByRole("option", { name: "Platform" }));
    await flushCommitQueue();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(["design", "platform"]);
    expect(
      screen.getByRole("button", {
        name: "Edit tags, currently Design, Platform",
      })
    ).toBeInTheDocument();
  });

  it("puts the previous set back when the write is refused", async () => {
    render(
      <Controlled
        initial={["design"]}
        onCommit={() => Promise.reject(new Error("refused"))}
      />
    );

    const popover = open("Edit tags, currently Design");
    fireEvent.click(within(popover).getByRole("option", { name: "Platform" }));
    // The pick shows at once, optimistically...
    expect(
      screen.getByRole("button", {
        name: "Edit tags, currently Design, Platform",
      })
    ).toBeInTheDocument();

    // ...and the refusal takes it back off the screen.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit tags, currently Design" })
      ).toBeInTheDocument()
    );
  });

  it("puts a created tag back off the screen when its write is refused", async () => {
    const onCreate = vi.fn();
    render(
      <Controlled
        initial={["design"]}
        onCommit={() => {
          throw new Error("refused");
        }}
        onCreate={onCreate}
      />
    );

    const popover = open("Edit tags, currently Design");
    fireEvent.change(within(popover).getByRole("combobox"), {
      target: { value: "  Novel " },
    });
    fireEvent.click(
      within(popover).getByRole("option", { name: "Make Novel" })
    );

    expect(onCreate).toHaveBeenCalledExactlyOnceWith("Novel");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit tags, currently Design" })
      ).toBeInTheDocument()
    );
  });

  it("offers to create only a label no tag already has, ignoring case", () => {
    render(<Controlled initial={[]} />);
    const popover = open("Set tags");
    const input = within(popover).getByRole("combobox");

    fireEvent.change(input, { target: { value: "plat" } });
    expect(
      within(popover).getByRole("option", { name: "Platform" })
    ).toBeInTheDocument();
    expect(
      within(popover).queryByRole("option", { name: "Design" })
    ).toBeNull();
    expect(
      within(popover).getByRole("option", { name: "Make plat" })
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "PLATFORM" } });
    expect(
      within(popover).queryByRole("option", { name: "Make PLATFORM" })
    ).toBeNull();
  });

  it("shows the empty message when there is no tag and nothing typed", () => {
    render(
      <InlineTagCell
        label="tags"
        onCommit={vi.fn()}
        options={[]}
        renderValues={renderValues}
        search={SEARCH}
        values={[]}
      />
    );
    const popover = open("Set tags");

    expect(within(popover).getByText("Nothing yet")).toBeInTheDocument();
  });

  it("keeps an applied tag no option carries, so it can be removed", async () => {
    const onCommit = vi.fn();
    render(<Controlled initial={["legacy", "design"]} onCommit={onCommit} />);

    const popover = open("Edit tags, currently legacy, Design");
    fireEvent.click(within(popover).getByRole("option", { name: "legacy" }));
    await flushCommitQueue();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(["design"]);
  });

  it("renders the host's chips in the header and removes through them", async () => {
    const onCommit = vi.fn();
    render(
      <InlineTagCell
        label="tags"
        onCommit={onCommit}
        options={OPTIONS}
        renderSelected={(value, remove) => (
          <button onClick={remove} type="button">
            Drop {value}
          </button>
        )}
        renderValues={renderValues}
        search={SEARCH}
        values={["design", "platform"]}
      />
    );

    const popover = open("Edit tags, currently Design, Platform");
    fireEvent.click(
      within(popover).getByRole("button", { name: "Drop design" })
    );
    await flushCommitQueue();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(["platform"]);
  });

  it("hands the list to the host after a create, until it finishes", () => {
    render(
      <InlineTagCell
        createdContent={(value, finish) => (
          <button onClick={finish} type="button">
            Colour {value}
          </button>
        )}
        label="tags"
        onCommit={vi.fn()}
        options={OPTIONS}
        renderValues={renderValues}
        search={SEARCH}
        values={[]}
      />
    );
    const popover = open("Set tags");
    fireEvent.change(within(popover).getByRole("combobox"), {
      target: { value: "Novel" },
    });
    fireEvent.click(
      within(popover).getByRole("option", { name: "Make Novel" })
    );

    fireEvent.click(
      within(popover).getByRole("button", { name: "Colour Novel" })
    );
    expect(
      within(popover).getByRole("option", { name: "Design" })
    ).toBeInTheDocument();
  });

  it("renders no control at all when read-only", () => {
    render(
      <InlineTagCell
        label="tags"
        onCommit={vi.fn()}
        options={OPTIONS}
        readOnly
        renderValues={renderValues}
        search={SEARCH}
        values={["design"]}
      />
    );

    expect(screen.getByText("design")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
