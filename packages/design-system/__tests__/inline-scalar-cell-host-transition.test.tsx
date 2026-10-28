import { InlineScalarCell } from "@closedloop-ai/design-system/components/ui/inline-scalar-cell";
import { INVALID_MESSAGE } from "@closedloop-ai/design-system/test/inline-scalar-cell-fixtures";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9588. A host transition — navigating, paging the rows out, rolling the
 * gating flag back, refreshing — is a blur the browser never delivers, so every
 * case here drives the transition INSTEAD of a blur. A case that blurs first
 * would pass on the shipped commit path and prove nothing about this one.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InlineScalarCell across a host transition", () => {
  it("commits a draft the host unmounts before any blur can reach it", () => {
    const onCommit = vi.fn();
    const { unmount } = render(
      <InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />
    );

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });

    // Nothing has committed yet, so the assertion after the unmount can only be
    // satisfied by the teardown path.
    expect(onCommit).not.toHaveBeenCalled();

    unmount();

    expect(onCommit).toHaveBeenCalledWith("9");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("does not re-send a value the user already committed", () => {
    const onCommit = vi.fn();
    // The `value` prop stays frozen, which is the real window: a committed
    // value has not been handed back down yet when the host moves.
    const { unmount } = render(
      <InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />
    );

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);

    unmount();

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("persists a parseable number on teardown and an unparseable one never", () => {
    const parseable = vi.fn();
    const parseableRender = render(
      <InlineScalarCell
        invalidMessage={INVALID_MESSAGE}
        label="Estimate"
        onCommit={parseable}
        type="number"
        value="7"
      />
    );
    const parseableInput = screen.getByRole("spinbutton", {
      name: "Estimate",
    });
    parseableInput.focus();
    fireEvent.change(parseableInput, { target: { value: "9" } });
    parseableRender.unmount();

    expect(parseable).toHaveBeenCalledWith("9");

    const refused = vi.fn();
    const refusedRender = render(
      <InlineScalarCell
        invalidMessage={INVALID_MESSAGE}
        label="Estimate"
        onCommit={refused}
        type="number"
        value="7"
      />
    );
    const refusedInput = screen.getByRole("spinbutton", { name: "Estimate" });
    // A number input blanks its own `value` for unparseable content ("12e"),
    // which is indistinguishable from a deliberate clear except through
    // `badInput`. jsdom does not compute validity, so it is stubbed here.
    Object.defineProperty(refusedInput, "validity", {
      configurable: true,
      value: { badInput: true },
    });
    refusedInput.focus();
    fireEvent.change(refusedInput, { target: { value: "" } });
    refusedRender.unmount();

    // Same teardown, same spy shape, opposite verdict: a typo must not leave
    // the grid as an erasure just because the host moved.
    expect(refused).not.toHaveBeenCalled();
  });

  it("does not commit an edit a dismissing host cancelled in the same batch", () => {
    const onCommit = vi.fn();
    render(<DismissOnEscape onCommit={onCommit} />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    // One Escape, two handlers: the cell reverts its draft and the host tears
    // the cell down. React batches both, so the revert never renders.
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Estimate" })).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("stops warning once the commit is dispatched, not once it is confirmed", () => {
    // Never settles, so the whole assertion sits inside the in-flight window.
    const onCommit = vi.fn(() => new Promise<void>(() => undefined));
    render(<InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    fireEvent.blur(input);

    // Deliberate, and shared with `useInlineEdit` through the same ledger
    // read: the warning covers typing nobody has sent, not a write already in
    // the mutation layer's hands. Pinned so it is not "fixed" into a warning
    // that can never clear.
    expect(onCommit).toHaveBeenCalledWith("9");
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it("goes quiet after a commit that re-rendered nothing", () => {
    // An EMPTY cell is the case with no render to hide behind: `setEditing` is
    // already true when Enter commits, and a clean settle resolves in silence,
    // so nothing React watches changes. A warning keyed on a rendered flag
    // would stay armed for the rest of the session.
    const onCommit = vi.fn();
    render(<InlineScalarCell label="Estimate" onCommit={onCommit} value="" />);

    fireEvent.click(screen.getByRole("button", { name: "Set Estimate" }));
    const input = screen.getByRole("textbox", { name: "Estimate" });
    fireEvent.change(input, { target: { value: "9" } });

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledWith("9");
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it("does not let Escape write an older value back over a committed one", () => {
    // `onCommit` returns void and the prop never moves — a shape the type
    // allows. Escape must discard what was typed since the last commit, not
    // reach for a prop the host has not caught up on.
    const onCommit = vi.fn();
    const { unmount } = render(
      <InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />
    );

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("9");

    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });

    unmount();

    // Never "7": Escape may cancel an edit, it may not undo a saved one.
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("PRD-722 DT-034 retries a rejected draft on teardown", async () => {
    const onCommit = vi
      .fn<(next: string) => Promise<unknown>>()
      .mockRejectedValue(new Error("refused"));
    const { unmount } = render(
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

    await waitFor(() => {
      expect(input).toHaveValue("9");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAccessibleDescription("Save failed");
      expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
    });
    expect(onCommit).toHaveBeenCalledTimes(1);

    unmount();

    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("stops warning about a refresh even when the host never echoes the commit", async () => {
    // `onCommit` is typed to allow `void`, so a consumer that accepts a write
    // without handing a new `value` back down is a shape this cell supports.
    const onCommit = vi.fn();
    render(<InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    fireEvent.blur(input);
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("9"));

    // The prop still says "7" and always will. A warning that can never be
    // cleared trains the reader to click through the one that matters.
    expect(input).toHaveValue("9");
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it("lets the browser ask before a refresh drops a draft, and stops once it is committed", async () => {
    render(<CommittingHarness initial="7" />);

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue("9"));

    // The same mechanism must go quiet once there is nothing to lose, or the
    // warning becomes noise that trains the user to click through it.
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it("leaves a reload alone in Electron, which has no dialog to ask with, and still commits on teardown", () => {
    vi.spyOn(globalThis.navigator, "userAgent", "get").mockReturnValue(
      ELECTRON_USER_AGENT
    );
    const onCommit = vi.fn();
    const { unmount } = render(
      <InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />
    );

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });

    // The draft is dirty, so a browser would be asked here. Electron cancels
    // the unload with nothing on screen instead.
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);

    unmount();

    expect(onCommit).toHaveBeenCalledWith("9");
  });
});

const ELECTRON_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ClosedLoop/1.0.0 Chrome/138.0.0.0 Electron/37.2.0 Safari/537.36";

/** Dispatches the real event and reports whether anything asked to block it. */
function dispatchBeforeUnload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  globalThis.window.dispatchEvent(event);
  return event;
}

/**
 * A host that dismisses on the same Escape the cell cancels on — a dialog, a
 * popover, any ancestor listening for it. Both handlers run in one React batch.
 */
function DismissOnEscape({
  onCommit,
}: Readonly<{ onCommit: (next: string) => void }>) {
  const [mounted, setMounted] = useState(true);
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: stands in for a dismissable layer; the real one is a Radix Dialog
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setMounted(false);
        }
      }}
      role="dialog"
    >
      {mounted ? (
        <InlineScalarCell label="Estimate" onCommit={onCommit} value="7" />
      ) : null}
    </div>
  );
}

/**
 * Holds the committed value the way a real table does, so the draft can
 * actually go clean again after a commit rather than staying permanently
 * different from a frozen prop.
 */
function CommittingHarness({ initial }: Readonly<{ initial: string }>) {
  const [value, setValue] = useState(initial);
  return (
    <InlineScalarCell label="Estimate" onCommit={setValue} value={value} />
  );
}
