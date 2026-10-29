import {
  CountCell,
  compareCountValues,
  isCountCellEmpty,
} from "@closedloop-ai/design-system/components/ui/count-cell";
import { BLANK_INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@closedloop-ai/design-system/components/ui/inline-edit-failure-behavior";
import {
  BLANK_NUMERIC_INVALID_MESSAGE_ERROR,
  InlineScalarCell,
} from "@closedloop-ai/design-system/components/ui/inline-scalar-cell";
import {
  compareMonoIds,
  MonoIdCell,
} from "@closedloop-ai/design-system/components/ui/mono-id-cell";
import { INVALID_MESSAGE } from "@closedloop-ai/design-system/test/inline-scalar-cell-fixtures";
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
 * ISS-6384. These three cells exist because the same data types were being
 * hand-rolled per table, so the assertions here are about RENDERED OUTPUT for a
 * given input — never "the component mounted". The three inputs that separate a
 * correct cell from a plausible one are zero, unknown, and the cancel path;
 * every case below pins one of those.
 */

describe("CountCell", () => {
  it("renders zero and unknown with the same glyph but never the same meaning", () => {
    render(
      <>
        <CountCell count={0} noun="comments" />
        <CountCell count={null} noun="reviews" />
      </>
    );

    // The point of the component: two blanks on one screen that a reader can
    // tell apart. Asserting each against a constant separately would pass even
    // if both said the same thing.
    expect(screen.getByText("No comments")).toBeInTheDocument();
    expect(screen.getByText("reviews unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No reviews")).not.toBeInTheDocument();
    expect(screen.queryByText("comments unavailable")).not.toBeInTheDocument();
    // Neither state may paint a number.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders a skeleton while the count is in flight, not a zero", () => {
    render(<CountCell count={null} loading noun="comments" />);

    expect(screen.getByText("Loading comments")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText("No comments")).not.toBeInTheDocument();
    expect(screen.queryByText("comments unavailable")).not.toBeInTheDocument();
  });

  it("degrades a count that cannot be true to unknown instead of showing it", () => {
    render(
      <>
        <CountCell count={-3} noun="comments" />
        <CountCell count={Number.NaN} noun="reviews" />
      </>
    );

    expect(screen.getByText("comments unavailable")).toBeInTheDocument();
    expect(screen.getByText("reviews unavailable")).toBeInTheDocument();
    expect(screen.queryByText("-3")).not.toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("degrades a count that is not a whole cardinality to unknown", () => {
    // `1.5 comments` is not a smaller lie than `-3`, and past
    // MAX_SAFE_INTEGER distinct counts collapse onto one value — neither can
    // be a cardinality, so neither may render or sort as a confident number.
    render(
      <>
        <CountCell count={1.5} noun="comments" />
        <CountCell count={2 ** 53} noun="reviews" />
      </>
    );

    expect(screen.getByText("comments unavailable")).toBeInTheDocument();
    expect(screen.getByText("reviews unavailable")).toBeInTheDocument();
    expect(screen.queryByText("1.5")).not.toBeInTheDocument();
    // The comparator has to agree, or a fractional value renders as unknown
    // and still sorts in among the real counts.
    expect(compareCountValues(1.5, 3)).toBeGreaterThan(0);
    expect(compareCountValues(3, 1.5)).toBeLessThan(0);
  });

  it("answers isCountCellEmpty with exactly what the cell renders", () => {
    // The helper tells a responsive card to drop the row. If it disagrees with
    // the renderer for even one input the card drops a row the cell would have
    // filled — most importantly a LOADING one, where a stale `0`/`null` is
    // still on the props and the cell owes a skeleton, not a blank.
    const cases: { count: number | null; loading: boolean }[] = [
      { count: 0, loading: false },
      { count: null, loading: false },
      { count: 1.5, loading: false },
      { count: 12, loading: false },
      { count: 0, loading: true },
      { count: null, loading: true },
      { count: 12, loading: true },
    ];

    for (const { count, loading } of cases) {
      const { container, unmount } = render(
        <CountCell count={count} loading={loading} noun="comments" />
      );
      // The em-dash sentinel is what makes a row droppable. A skeleton is not
      // it, and neither is a painted number.
      const rendersEmptyValue = container.textContent?.includes("—") ?? false;

      // Compared as one object so a failure names the input that diverged.
      expect({
        count,
        loading,
        empty: isCountCellEmpty(count, loading),
      }).toEqual({ count, loading, empty: rendersEmptyValue });
      unmount();
    }
  });

  it("renders a plain, unbadged count with no control behind it", () => {
    const { container } = render(<CountCell count={12} noun="comments" />);

    // The prototype rendered a <button aria-label> with no handler. A keyboard
    // user reaching a control that does nothing is the defect being fixed here.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // A count is not a status. The chip is the affordance on the interactive
    // branches, so a plain count must not wear one — adopting this primitive
    // otherwise re-badges the columns ISS-5840 just unbadged.
    expect(container.querySelector('[data-slot="chip"]')).toBeNull();
    // `aria-label` is prohibited on the generic role a bare <span> carries, so
    // the name has to be real text in the DOM. `getByLabelText` would happily
    // match the dropped attribute and report a name no reader ever hears.
    expect(screen.getByText("12 comments")).toBeInTheDocument();
    expect(screen.getByText("12")).toHaveClass("tabular-nums");
  });

  it("becomes a button only when a handler is supplied, and never for zero", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <CountCell count={12} noun="comments" onSelect={onSelect} />
    );

    const button = screen.getByRole("button", { name: "12 comments" });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);

    rerender(<CountCell count={0} noun="comments" onSelect={onSelect} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("No comments")).toBeInTheDocument();
  });

  it("keeps showing the skeleton while a stale count is still on the props", () => {
    // A refetch leaves the previous count on the props while the new one is in
    // flight. Painting `12` through that window is the same lie as painting a
    // premature `0`, so `loading` wins over any count, not only over `null`.
    render(<CountCell count={12} loading noun="comments" />);

    expect(screen.getByText("Loading comments")).toBeInTheDocument();
    expect(screen.queryByText("12")).not.toBeInTheDocument();
  });

  it("renders through the caller's link, and prefers it over a click handler", () => {
    const onSelect = vi.fn();
    render(
      <CountCell
        count={4}
        noun="linked sessions"
        onSelect={onSelect}
        renderLink={(content, accessibleName) => (
          <a aria-label={accessibleName} href="/branches/1/sessions">
            {content}
          </a>
        )}
      />
    );

    // Documented precedence: a surface that supplies navigation must get
    // navigation, not a button that swallows the click.
    const link = screen.getByRole("link", { name: "4 linked sessions" });
    expect(link).toHaveAttribute("href", "/branches/1/sessions");
    expect(link).toHaveTextContent("4");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("right-aligns every state under a numeric column", () => {
    // Three independent return branches each apply the alignment, so one
    // regressing is invisible unless all three are read.
    const { container } = render(
      <>
        <CountCell alignEnd count={12} noun="comments" />
        <CountCell alignEnd count={0} noun="comments" />
        <CountCell alignEnd count={null} loading noun="comments" />
      </>
    );

    const aligned = container.querySelectorAll(".ml-auto");
    expect(aligned).toHaveLength(3);
  });

  it("names one of a thing in the singular", () => {
    // Branches already spells this out and its own test asserts "1 linked
    // session". A primitive that says "1 linked sessions" cannot absorb the
    // call site it was written for.
    const noun = { one: "linked session", other: "linked sessions" };
    render(
      <>
        <CountCell count={1} noun={noun} />
        <CountCell count={2} noun={noun} />
      </>
    );

    expect(screen.getByText("1 linked session")).toBeInTheDocument();
    expect(screen.getByText("2 linked sessions")).toBeInTheDocument();
  });

  it("sorts unknown counts last in both directions", () => {
    const values: (number | null)[] = [3, null, 0, 10];

    expect([...values].sort((a, b) => compareCountValues(a, b))).toEqual([
      0,
      3,
      10,
      null,
    ]);
    // Flipping the direction must not promote "we don't know" above 10.
    expect(
      [...values].sort((a, b) => compareCountValues(a, b, "desc"))
    ).toEqual([10, 3, 0, null]);
  });
});

describe("InlineScalarCell", () => {
  it("PRD-722 DT-067 refuses retained failure with blank error copy", () => {
    expect(() =>
      render(
        <InlineScalarCell
          label="Estimate"
          onCommit={vi.fn()}
          retainRejectedDraft
          saveErrorMessage="   "
          value="7"
        />
      )
    ).toThrow(BLANK_INLINE_EDIT_SAVE_ERROR_MESSAGE);
  });

  it("does not commit the value Escape just reverted", () => {
    const onCommit = vi.fn();
    render(<InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    // Escape reverts; nothing may write "9" back out on the way.
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue("7");
  });

  it("commits exactly once on Enter", () => {
    const onCommit = vi.fn();
    render(<InlineScalarCellHarness initial="7" onCommit={onCommit} />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("9");
    expect(screen.getByRole("textbox", { name: "Estimate" })).toHaveValue("9");
  });

  it("does not commit when the value was only visited, not changed", () => {
    const onCommit = vi.fn();
    render(<InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("edits a number as a numeric field", () => {
    const onCommit = vi.fn();
    render(
      <InlineScalarCell
        alignEnd
        invalidMessage={INVALID_MESSAGE}
        label="Estimate"
        onCommit={onCommit}
        type="number"
        value="7"
      />
    );

    // `getByRole("textbox")` cannot find a number input, which is the point:
    // the variant must actually change the control, not just its styling.
    const input = screen.getByRole("spinbutton", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith("9");
  });

  it("PRD-722 DT-033 DT-034 keeps and marks a rejected draft", async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValue(new Error("the server refused it"));
    render(
      <InlineScalarCell
        label="Estimate"
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage="Save failed"
        value="7"
      />
    );

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    input.blur();

    await waitFor(() => expect(input).toHaveValue("9"));
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });

  it("PRD-722 DT-062 clears a retained failure when the draft returns to confirmation", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("refused")));
    render(
      <InlineScalarCell
        label="Estimate"
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage="Save failed"
        value="7"
      />
    );

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    input.blur();
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));

    fireEvent.change(input, { target: { value: "7" } });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    input.blur();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("7");
  });

  it("ignores a stale rejection once a newer commit has superseded it", async () => {
    // Two commits in flight at once: the first fails, but only AFTER the second
    // has already saved. An unscoped rollback restores the first commit's
    // captured `previous` ("7") and the cell then displays a value the user
    // replaced and the server accepted.
    const settlers: {
      reject: (reason: unknown) => void;
      resolve: () => void;
    }[] = [];
    const onCommit = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settlers.push({ reject, resolve });
        })
    );
    render(<InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "11" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(2);

    const [first, second] = onCommit.mock.results.map(
      (entry) => entry.value as Promise<void>
    );
    // The newer commit lands first, then the older one fails.
    settlers[1].resolve();
    await act(async () => {
      await second;
    });
    settlers[0].reject(new Error("the server refused it"));
    // The component attached its `.catch` before this one, so awaiting here
    // guarantees the rollback decision has already been made.
    await act(async () => {
      await first.catch(() => undefined);
    });

    expect(input).toHaveValue("11");
    // The superseded rollback must not have rewritten the committed value
    // either: leaving "7" there makes the next blur re-commit "11".
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest rejected draft while the ledger retains the confirmation", async () => {
    // Two commits in flight, BOTH refused. Scoping the rollback to "is this
    // still the latest commit?" restores the newer commit's captured previous
    // ("9" — itself only optimistic) and then drops the older commit's own
    // rejection as stale, leaving "9" on screen although the server took
    // neither value.
    const settlers: { reject: (reason: unknown) => void }[] = [];
    const onCommit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          settlers.push({ reject });
        })
    );
    render(
      <InlineScalarCell
        label="Estimate"
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage="Save failed"
        value="7"
      />
    );

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "11" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(2);

    const [first, second] = onCommit.mock.results.map(
      (entry) => entry.value as Promise<void>
    );
    settlers[1].reject(new Error("the server refused it"));
    await act(async () => {
      await second.catch(() => undefined);
    });
    settlers[0].reject(new Error("the server refused it"));
    await act(async () => {
      await first.catch(() => undefined);
    });

    expect(input).toHaveValue("11");
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });

  it("lets an authoritative value outlive the commits it superseded", async () => {
    // A refetch (or another user's edit) lands while TWO commits are still in
    // flight. The prop is the server's own answer and is newer than both, so
    // neither settling commit may repaint over it — not the one that is
    // refused, and not the older one still outstanding underneath it.
    const settlers: { reject: (reason: unknown) => void }[] = [];
    const onCommit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          settlers.push({ reject });
        })
    );
    const { rerender } = render(
      <InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />
    );

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "11" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(2);

    rerender(
      <InlineScalarCell label="Estimate" onCommit={onCommit} value="12" />
    );
    expect(input).toHaveValue("12");

    const [first, second] = onCommit.mock.results.map(
      (entry) => entry.value as Promise<void>
    );
    // Refusing "11" must not surface the abandoned "9" underneath it.
    settlers[1].reject(new Error("the server refused it"));
    await act(async () => {
      await second.catch(() => undefined);
    });
    expect(input).toHaveValue("12");

    settlers[0].reject(new Error("the server refused it"));
    await act(async () => {
      await first.catch(() => undefined);
    });
    expect(input).toHaveValue("12");
  });

  it("PRD-722 DT-057 rolls back a synchronous refusal without the retained-draft opt-in", () => {
    // Not every refusal arrives as a rejected promise. A synchronous throw
    // escapes the handler with the draft already recorded as committed, so the
    // compatibility callers without adjacent error copy restore confirmation.
    const onCommit = vi.fn(() => {
      throw new Error("the server refused it");
    });
    render(<InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("7");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("PRD-722 DT-057 rolls back a non-native thenable refusal without the retained-draft opt-in", async () => {
    // A cross-realm promise (an iframe, a vm context) or a library thenable is
    // not `instanceof Promise`, so an identity check on the return value would
    // skip the compatibility rollback branch entirely.
    const refusingThenable = {
      // The rule guards against writing a thenable by accident; here it is the
      // subject under test, and stubbing the shape is the only way to reach the
      // assimilation path from jsdom, which has no second realm to borrow one from.
      // biome-ignore lint/suspicious/noThenProperty: deliberate thenable under test
      then(_onFulfilled: unknown, onRejected: (reason: unknown) => void) {
        onRejected(new Error("the server refused it"));
      },
    };
    // Test-only double cast: the point of the case is a value the prop type
    // cannot describe reaching the component at runtime.
    const onCommit = vi.fn(() => refusingThenable as unknown as Promise<never>);
    render(<InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(input).toHaveValue("7"));
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("never persists numeric input the browser could not parse", () => {
    const onCommit = vi.fn();
    render(
      <InlineScalarCell
        invalidMessage={INVALID_MESSAGE}
        label="Estimate"
        onCommit={onCommit}
        type="number"
        value="7"
      />
    );

    const input = screen.getByRole("spinbutton", { name: "Estimate" });
    // A number input blanks its own `value` for unparseable content ("12e"),
    // which is indistinguishable from a deliberate clear except through
    // `badInput`. jsdom does not compute validity, so it is stubbed here.
    Object.defineProperty(input, "validity", {
      configurable: true,
      value: { badInput: true },
    });
    input.focus();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
  });

  // whitlockk review, PR #8181: `invalidMessage: string` accepts `""`, and the
  // announce predicate reads a blank as "no message" — so the silent numeric
  // refusal the required prop forbids would type-check right back in. `string`
  // cannot say "non-blank", so the runtime says it.
  it("refuses a number cell whose invalidMessage is blank", () => {
    // React reports a render throw through console.error; the throw is the
    // assertion, so the report itself is noise here.
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const renderWithMessage = (invalidMessage: string) => () => {
      render(
        <InlineScalarCell
          invalidMessage={invalidMessage}
          label="Estimate"
          onCommit={vi.fn()}
          type="number"
          value="7"
        />
      );
    };

    try {
      expect(renderWithMessage("")).toThrow(
        BLANK_NUMERIC_INVALID_MESSAGE_ERROR
      );
      expect(renderWithMessage("   ")).toThrow(
        BLANK_NUMERIC_INVALID_MESSAGE_ERROR
      );
      // The same call with words must still mount, or the two above would pass
      // on a cell that never renders at all.
      expect(renderWithMessage(INVALID_MESSAGE)).not.toThrow();
    } finally {
      reported.mockRestore();
    }
  });

  it("offers an empty editable cell as an action, and a read-only one as text", () => {
    const { rerender } = render(
      <InlineScalarCell label="Estimate" onCommit={vi.fn()} value="" />
    );

    // Names what activating it DOES, not what the cell is.
    expect(
      screen.getByRole("button", { name: "Set Estimate" })
    ).toBeInTheDocument();

    rerender(
      <InlineScalarCell label="Estimate" onCommit={vi.fn()} readOnly value="" />
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    rerender(
      <InlineScalarCell
        label="Estimate"
        onCommit={vi.fn()}
        readOnly
        value="7"
      />
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});

describe("MonoIdCell", () => {
  it("orders versions by segment, not by stripped digits", () => {
    // The prototype's comparator was `Number(value.replace(/\D/g, ""))`, which
    // reads v1.10 as 110 and v1.9 as 19 — so it sorts v1.10 ABOVE v2.0 and
    // BELOW nothing. Each expectation below is one of the orderings it got
    // wrong.
    expect(compareMonoIds("v1.9", "v1.10")).toBeLessThan(0);
    expect(compareMonoIds("v1.10", "v2.0")).toBeLessThan(0);
    expect(
      ["v1.10", "v2.0", "v1.9", "v10.0"].sort((a, b) => compareMonoIds(a, b))
    ).toEqual(["v1.9", "v1.10", "v2.0", "v10.0"]);
  });

  it("keeps digit runs past MAX_SAFE_INTEGER distinct", () => {
    // `Number("9007199254740993")` is `9007199254740992`, so a `Number(left) -
    // Number(right)` comparator reports these two build ids as the same value
    // and the sort silently keeps whatever order it was handed.
    expect(
      compareMonoIds("build-9007199254740992", "build-9007199254740993")
    ).toBeLessThan(0);
    expect(
      compareMonoIds("build-9007199254740993", "build-9007199254740992")
    ).toBeGreaterThan(0);
    expect(
      ["build-9007199254740993", "build-9007199254740992"].sort((a, b) =>
        compareMonoIds(a, b)
      )
    ).toEqual(["build-9007199254740992", "build-9007199254740993"]);
  });

  it("returns a usable ordering for a digit run that overflows to Infinity", () => {
    // Both runs become `Infinity` under `Number`, and `Infinity - Infinity` is
    // `NaN` — a comparator returning NaN leaves the sort order undefined.
    const shorter = `v${"1".repeat(400)}`;
    const longer = `v${"1".repeat(401)}`;

    const result = compareMonoIds(shorter, longer);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBeLessThan(0);
    expect(compareMonoIds(longer, shorter)).toBeGreaterThan(0);
  });

  it("orders ordinary short numeric identifiers by value, not by digit count", () => {
    // The exact-compare path must not regress the everyday case: leading zeros
    // are still insignificant and 9 still sorts below 10.
    expect(compareMonoIds("build-9", "build-10")).toBeLessThan(0);
    expect(compareMonoIds("build-007", "build-7")).toBe(0);
    expect(compareMonoIds("build-0", "build-1")).toBeLessThan(0);
    expect(
      ["build-10", "build-2", "build-1", "build-20"].sort((a, b) =>
        compareMonoIds(a, b)
      )
    ).toEqual(["build-1", "build-2", "build-10", "build-20"]);
  });

  it("sorts missing identifiers last in both directions", () => {
    const values: (string | null)[] = ["v1.9", null, "v1.10"];

    expect([...values].sort((a, b) => compareMonoIds(a, b))).toEqual([
      "v1.9",
      "v1.10",
      null,
    ]);
    expect([...values].sort((a, b) => compareMonoIds(a, b, "desc"))).toEqual([
      "v1.10",
      "v1.9",
      null,
    ]);
  });

  it("announces the identifier with its kind and stays non-interactive", () => {
    render(<MonoIdCell label="Version" value="v1.10" />);

    // A bare `4f2a1c` or `v1.10` read on its own names nothing — and on a
    // <span> an `aria-label` naming it would simply be dropped, so the name has
    // to be text.
    expect(screen.getByText("Version v1.10")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("becomes a working button only when a handler is supplied", () => {
    const onSelect = vi.fn();
    render(<MonoIdCell label="Version" onSelect={onSelect} value="v1.10" />);

    // The prototype's version cell was a <button> with nothing behind it. The
    // button variant exists precisely so that never ships again, so the click
    // has to actually reach the handler and the name has to survive the swap.
    const button = screen.getByRole("button", { name: "Version v1.10" });
    fireEvent.click(button);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(button).toHaveTextContent("v1.10");
  });

  it("renders the shared empty value when there is no identifier", () => {
    render(<MonoIdCell label="Version" value={null} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByTitle("No Version")).toHaveTextContent("—");
  });
});

/**
 * Holds the committed value the way a real table does, so the Enter path
 * exercises the prop actually changing underneath the cell rather than a frozen
 * `value` that would hide a double commit.
 */
function InlineScalarCellHarness({
  initial,
  onCommit,
}: Readonly<{ initial: string; onCommit: (next: string) => void }>) {
  const [value, setValue] = useState(initial);
  return (
    <InlineScalarCell
      label="Estimate"
      onCommit={(next) => {
        onCommit(next);
        setValue(next);
      }}
      value={value}
    />
  );
}
