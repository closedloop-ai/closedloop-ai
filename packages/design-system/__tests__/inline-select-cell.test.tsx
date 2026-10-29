import {
  InlineMultiSelectCell,
  InlineSelectCell,
} from "@closedloop-ai/design-system/components/ui/inline-select-cell";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-9351. This cell exists because the same picker was hand-rolled seven
 * times and not one copy put the previous value back when the write was
 * refused, so the assertions below are about what the CELL SHOWS after a
 * commit settles — never that `onCommit` was called, which every broken copy
 * would also satisfy.
 *
 * Every fixture renders TWO options with different labels and, where the
 * subject is a cell, two cells with different committed values. A single-option
 * fixture makes "it edited the right thing" unobservable: the assertion passes
 * for a component that always picks the first option and for one that edits
 * whichever cell it feels like.
 */

const PRIORITIES = [
  { value: "urgent", label: "Urgent" },
  { value: "low", label: "Low" },
];

const LABELS = [
  { value: "infra", label: "Infra" },
  { value: "ux", label: "UX" },
];

/**
 * A commit is DISPATCHED behind the one before it, so `onCommit` is called a
 * microtask after the click rather than during it. Every assertion about
 * whether it was called — including a "was not called" — has to let that queue
 * run first, or it passes for a cell that simply had not got there yet.
 */
async function flushCommitQueue() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openMenu(name: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name }),
    new MouseEvent("pointerdown", { bubbles: true })
  );
}

/**
 * A multi-select menu deliberately stays open across picks, and Radix marks the
 * page behind an open menu inert — so the trigger's accessible name can only be
 * read once the menu is dismissed. Dismissing is also the assertion's point:
 * the committed pick must survive the dismissal, not be discarded with it.
 */
function dismissMenu() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

describe("InlineSelectCell", () => {
  it("names the trigger for the field and its current value", () => {
    render(
      <>
        <InlineSelectCell
          label="Priority"
          onCommit={() => undefined}
          options={PRIORITIES}
          value="urgent"
        />
        <InlineSelectCell
          label="Priority"
          onCommit={() => undefined}
          options={PRIORITIES}
          value=""
        />
      </>
    );

    // A trigger whose only text is the chip "Urgent" never says what it sets,
    // and an empty one says nothing at all.
    expect(
      screen.getByRole("button", { name: "Edit Priority, currently Urgent" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set Priority" })
    ).toBeInTheDocument();
  });

  it("commits the option the user picked, in the cell they picked it in", async () => {
    const onCommitFirst = vi.fn();
    const onCommitSecond = vi.fn();
    render(
      <>
        <InlineSelectCell
          label="Priority"
          onCommit={onCommitFirst}
          options={PRIORITIES}
          value="urgent"
        />
        <InlineSelectCell
          label="Severity"
          onCommit={onCommitSecond}
          options={PRIORITIES}
          value="low"
        />
      </>
    );

    openMenu("Edit Severity, currently Low");
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Urgent" })
    );

    await flushCommitQueue();
    expect(onCommitSecond).toHaveBeenCalledWith("urgent");
    expect(onCommitFirst).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit Severity, currently Urgent" })
      ).toBeInTheDocument()
    );
  });

  it("puts the previous option back when the commit is rejected", async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValue(new Error("the server refused it"));
    render(
      <InlineSelectCell
        label="Priority"
        onCommit={onCommit}
        options={PRIORITIES}
        value="urgent"
      />
    );

    openMenu("Edit Priority, currently Urgent");
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Low" }));

    // Leaving "Low" on screen tells the reader a value was saved that was not.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit Priority, currently Urgent" })
      ).toBeInTheDocument()
    );
  });

  it("writes nothing when the menu is dismissed", async () => {
    const onCommit = vi.fn();
    render(
      <InlineSelectCell
        label="Priority"
        onCommit={onCommit}
        options={PRIORITIES}
        value="urgent"
      />
    );

    openMenu("Edit Priority, currently Urgent");
    await screen.findByRole("menuitemradio", { name: "Low" });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("menuitemradio", { name: "Low" })
      ).not.toBeInTheDocument()
    );
    await flushCommitQueue();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not write when the user re-picks the committed option", async () => {
    const onCommit = vi.fn();
    render(
      <InlineSelectCell
        label="Priority"
        onCommit={onCommit}
        options={PRIORITIES}
        value="urgent"
      />
    );

    openMenu("Edit Priority, currently Urgent");
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Urgent" })
    );

    await flushCommitQueue();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows a committed value no option carries rather than an empty cell", () => {
    render(
      <InlineSelectCell
        label="Priority"
        onCommit={() => undefined}
        options={PRIORITIES}
        value="archived"
      />
    );

    // "Set Priority" would tell the reader the field is empty while the server
    // holds "archived".
    expect(
      screen.getByRole("button", {
        name: "Edit Priority, currently archived (unknown)",
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Set Priority" })
    ).not.toBeInTheDocument();
  });

  it("renders no control at all when read-only", () => {
    render(
      <InlineSelectCell
        label="Priority"
        onCommit={() => undefined}
        options={PRIORITIES}
        readOnly
        value="urgent"
      />
    );

    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("InlineMultiSelectCell", () => {
  it("adds the toggled value and leaves the rest of the set alone", async () => {
    const onCommit = vi.fn();
    render(
      <InlineMultiSelectCell
        label="Labels"
        onCommit={onCommit}
        options={LABELS}
        values={["infra"]}
      />
    );

    openMenu("Edit Labels, currently Infra");
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "UX" })
    );

    await flushCommitQueue();
    expect(onCommit).toHaveBeenCalledWith(["infra", "ux"]);
    dismissMenu();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit Labels, currently Infra, UX" })
      ).toBeInTheDocument()
    );
  });

  it("removes a value that is already in the set", async () => {
    const onCommit = vi.fn();
    render(
      <InlineMultiSelectCell
        label="Labels"
        onCommit={onCommit}
        options={LABELS}
        values={["infra", "ux"]}
      />
    );

    openMenu("Edit Labels, currently Infra, UX");
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Infra" })
    );

    await flushCommitQueue();
    expect(onCommit).toHaveBeenCalledWith(["ux"]);
  });

  it("puts the previous set back when the toggle is rejected", async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValue(new Error("the server refused it"));
    render(
      <InlineMultiSelectCell
        label="Labels"
        onCommit={onCommit}
        options={LABELS}
        values={["infra"]}
      />
    );

    openMenu("Edit Labels, currently Infra");
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "UX" })
    );
    dismissMenu();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit Labels, currently Infra" })
      ).toBeInTheDocument()
    );
  });

  it("keeps a value no option carries, and says it is unknown", () => {
    render(
      <InlineMultiSelectCell
        label="Labels"
        onCommit={() => undefined}
        options={LABELS}
        values={["infra", "retired"]}
      />
    );

    // The trigger must not read "Infra" alone: the cell goes on persisting
    // "retired" on the next toggle, so hiding it is the cell lying about what
    // is stored. Rendered in WORDS, not by colour (WCAG 1.4.1).
    expect(
      screen.getByRole("button", {
        name: "Edit Labels, currently Infra, retired (unknown)",
      })
    ).toBeInTheDocument();
  });

  it("re-submits the unknown value it is showing, not a set without it", async () => {
    const onCommit = vi.fn();
    render(
      <InlineMultiSelectCell
        label="Labels"
        onCommit={onCommit}
        options={LABELS}
        values={["retired"]}
      />
    );

    openMenu("Edit Labels, currently retired (unknown)");
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "UX" })
    );

    await flushCommitQueue();
    expect(onCommit).toHaveBeenCalledWith(["retired", "ux"]);
  });

  it("dispatches a second toggle only once the first has settled", async () => {
    const settle: ((value: unknown) => void)[] = [];
    const onCommit = vi.fn(
      () =>
        new Promise((resolve) => {
          settle.push(resolve);
        })
    );
    render(
      <InlineMultiSelectCell
        label="Labels"
        onCommit={onCommit}
        options={LABELS}
        values={[]}
      />
    );

    openMenu("Set Labels");
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Infra" })
    );
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "UX" })
    );
    await flushCommitQueue();

    // Two whole-set replacements in flight at once let the server end on the
    // obsolete one while the cell keeps showing the newer, which nothing can
    // detect. The second must not be sent until the first has answered.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(["infra"]);

    settle[0]?.(undefined);
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    expect(onCommit).toHaveBeenLastCalledWith(["infra", "ux"]);
  });

  it("collapses the values that do not fit into a +N rather than spilling", () => {
    render(
      <InlineMultiSelectCell
        label="Labels"
        onCommit={() => undefined}
        options={LABELS}
        values={["infra", "ux"]}
      />
    );

    // jsdom reports every width as 0, so nothing fits and BOTH collapse. What
    // this pins is the wiring, not the arithmetic: without the measured
    // container and its overflow affordance, `Chip`'s `shrink-0` row simply
    // renders past the h-7 trigger into the next column. The trigger's name
    // still carries every value, which is what keeps the collapse honest.
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Labels, currently Infra, UX" })
    ).toBeInTheDocument();
  });

  it("keeps a pick in flight when the parent rebuilds the array each render", async () => {
    // A grid host that maps rows inline hands down a FRESH array instance on
    // every render while the committed contents are unchanged, and a commit is
    // exactly what makes such a host re-render. Keying the ledger reset on
    // array identity would reset it mid-flight and throw the optimistic pick
    // away; keying it on the VALUE keeps the pick on screen until the server
    // answers.
    const onCommit = vi.fn(() => new Promise<void>(() => undefined));
    render(<RebuildingParent onCommit={onCommit} />);

    openMenu("Edit Labels, currently Infra");
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "UX" })
    );
    await flushCommitQueue();

    expect(onCommit).toHaveBeenCalledWith(["infra", "ux"]);
    dismissMenu();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit Labels, currently Infra, UX" })
      ).toBeInTheDocument()
    );
  });

  it("names an empty set for the action rather than the absence", () => {
    render(
      <InlineMultiSelectCell
        label="Labels"
        onCommit={() => undefined}
        options={LABELS}
        values={[]}
      />
    );

    expect(
      screen.getByRole("button", { name: "Set Labels" })
    ).toBeInTheDocument();
  });
});

/**
 * A parent that hands down a fresh array instance on every render while the
 * committed contents are unchanged — the shape a grid host takes when it maps
 * rows inline — and that re-renders in response to the commit itself, so the
 * rebuild lands while the write is still in flight.
 */
function RebuildingParent({
  onCommit,
}: {
  onCommit: (next: readonly string[]) => Promise<unknown>;
}) {
  const [, force] = useState(0);
  return (
    <InlineMultiSelectCell
      label="Labels"
      onCommit={(next) => {
        force((count) => count + 1);
        return onCommit(next);
      }}
      options={LABELS}
      values={["infra"]}
    />
  );
}
