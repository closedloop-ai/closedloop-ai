import {
  InlineReferenceCell,
  type InlineReferenceCellProps,
} from "@closedloop-ai/design-system/components/ui/inline-reference-cell";
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
 * PRD-722 (ISS-9349, ISS-12642): the reference champion.
 *
 * What is pinned is what the CELL SHOWS once a write settles, and two targets
 * with different handles sit in every fixture, so "it linked the target the
 * user chose" cannot be satisfied by a cell that always links the first.
 */

const OPTIONS = [
  { value: "t-1", label: "ISS-1", description: "First issue" },
  { value: "t-2", label: "ISS-2", description: "Second issue" },
];
const HANDLES = new Map(OPTIONS.map((option) => [option.value, option.label]));
const FIRST_ISSUE = /First issue/;
const SECOND_ISSUE = /Second issue/;

async function flushCommitQueue() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function Controlled({
  initial,
  onCommit,
  ...rest
}: Partial<Omit<InlineReferenceCellProps, "onCommit" | "values" | "query">> & {
  initial: readonly string[];
  onCommit?: (next: readonly string[]) => unknown;
}) {
  const [values, setValues] = useState(initial);
  const [query, setQuery] = useState("");
  return (
    <InlineReferenceCell
      label="Links"
      onCommit={(next) =>
        Promise.resolve(onCommit?.(next)).then(() => setValues(next))
      }
      onQueryChange={setQuery}
      options={OPTIONS.filter((option) =>
        option.description.toLowerCase().includes(query.toLowerCase())
      )}
      query={query}
      renderValues={(shown) => (
        <span>{shown.map((value) => HANDLES.get(value)).join(" ")}</span>
      )}
      search={{ label: "Search links", placeholder: "Find one" }}
      valueLabel={(value) => HANDLES.get(value) ?? value}
      values={values}
      {...rest}
    />
  );
}

function open(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}

describe("InlineReferenceCell, single", () => {
  it("names the trigger for the field and its target, or the action when empty", () => {
    render(
      <>
        <Controlled initial={["t-1"]} />
        <Controlled initial={[]} />
      </>
    );

    expect(
      screen.getByRole("button", { name: "Edit Links, currently ISS-1" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set Links" })
    ).toBeInTheDocument();
  });

  it("links the target the user chose and closes", async () => {
    const onCommit = vi.fn();
    render(<Controlled initial={["t-1"]} onCommit={onCommit} />);

    const popover = open("Edit Links, currently ISS-1");
    fireEvent.click(
      within(popover).getByRole("option", { name: SECOND_ISSUE })
    );
    await flushCommitQueue();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(["t-2"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit Links, currently ISS-2" })
    ).toBeInTheDocument();
  });

  it("puts the previous target back when the write is refused", async () => {
    render(
      <Controlled
        initial={["t-1"]}
        onCommit={() => Promise.reject(new Error("refused"))}
      />
    );

    const popover = open("Edit Links, currently ISS-1");
    fireEvent.click(
      within(popover).getByRole("option", { name: SECOND_ISSUE })
    );
    expect(
      screen.getByRole("button", { name: "Edit Links, currently ISS-2" })
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit Links, currently ISS-1" })
      ).toBeInTheDocument()
    );
  });

  it("writes nothing when the user chooses the target already linked", async () => {
    const onCommit = vi.fn();
    render(<Controlled initial={["t-1"]} onCommit={onCommit} />);

    const popover = open("Edit Links, currently ISS-1");
    fireEvent.click(within(popover).getByRole("option", { name: FIRST_ISSUE }));
    await flushCommitQueue();

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears through the host's clear action, and restores on refusal", async () => {
    render(
      <Controlled
        clearLabel="Unlink"
        initial={["t-1"]}
        onCommit={() => Promise.reject(new Error("refused"))}
      />
    );

    const popover = open("Edit Links, currently ISS-1");
    fireEvent.click(within(popover).getByRole("button", { name: "Unlink" }));
    expect(
      screen.getByRole("button", { name: "Set Links" })
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit Links, currently ISS-1" })
      ).toBeInTheDocument()
    );
  });

  it("hands the query to the host and offers what it returns", () => {
    render(<Controlled initial={[]} />);
    const popover = open("Set Links");

    fireEvent.change(
      within(popover).getByRole("combobox", { name: "Search links" }),
      {
        target: { value: "second" },
      }
    );

    expect(
      within(popover).getByRole("option", { name: SECOND_ISSUE })
    ).toBeInTheDocument();
    expect(
      within(popover).queryByRole("option", { name: FIRST_ISSUE })
    ).toBeNull();
  });

  it("renders the host's status in place of the options", () => {
    render(<Controlled initial={[]} listStatus={<p>Still loading</p>} />);
    const popover = open("Set Links");

    expect(within(popover).getByText("Still loading")).toBeInTheDocument();
    expect(within(popover).queryByRole("option")).toBeNull();
  });
});

describe("InlineReferenceCell, multiple", () => {
  it("toggles each target and keeps the list open", async () => {
    const onCommit = vi.fn();
    render(
      <Controlled
        done={{ label: "Close", summary: (count) => `${count} linked` }}
        initial={["t-1"]}
        multiple
        onCommit={onCommit}
      />
    );

    const popover = open("Edit Links, currently ISS-1");
    fireEvent.click(
      within(popover).getByRole("option", { name: SECOND_ISSUE })
    );
    await flushCommitQueue();

    expect(onCommit).toHaveBeenLastCalledWith(["t-1", "t-2"]);
    expect(within(popover).getByText("2 linked")).toBeInTheDocument();
    expect(
      within(popover).getByRole("option", { name: SECOND_ISSUE })
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(popover).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("puts the previous set back when a toggle is refused", async () => {
    render(
      <Controlled
        initial={["t-1"]}
        multiple
        onCommit={() => Promise.reject(new Error("refused"))}
      />
    );

    const popover = open("Edit Links, currently ISS-1");
    fireEvent.click(within(popover).getByRole("option", { name: FIRST_ISSUE }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit Links, currently ISS-1" })
      ).toBeInTheDocument()
    );
  });

  it("keeps a queued pick when the host echoes an earlier write as a new array", async () => {
    const settles: Array<() => void> = [];
    const onCommit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settles.push(resolve);
        })
    );
    const props = {
      label: "Links",
      multiple: true,
      onCommit,
      onQueryChange: () => undefined,
      options: OPTIONS,
      query: "",
      renderValues: (shown: readonly string[]) => (
        <span>{shown.map((value) => HANDLES.get(value)).join(" ")}</span>
      ),
      search: { label: "Search links", placeholder: "Find one" },
      valueLabel: (value: string) => HANDLES.get(value) ?? value,
    } as const;
    const { rerender } = render(<InlineReferenceCell {...props} values={[]} />);

    const popover = open("Set Links");
    fireEvent.click(within(popover).getByRole("option", { name: FIRST_ISSUE }));
    fireEvent.click(
      within(popover).getByRole("option", { name: SECOND_ISSUE })
    );
    await flushCommitQueue();
    await act(async () => {
      settles[0]?.();
      await Promise.resolve();
    });
    // The host refetches after the first write and hands back a fresh array.
    rerender(<InlineReferenceCell {...props} values={["t-1"]} />);
    await flushCommitQueue();

    expect(
      within(popover).getByRole("option", { name: SECOND_ISSUE })
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(popover).getByRole("option", { name: FIRST_ISSUE }));
    await act(async () => {
      settles[1]?.();
      await Promise.resolve();
    });
    await flushCommitQueue();

    expect(onCommit).toHaveBeenLastCalledWith(["t-2"]);
  });

  it("renders no control at all when read-only", () => {
    render(<Controlled initial={["t-2"]} readOnly />);

    expect(screen.getByText("ISS-2")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
