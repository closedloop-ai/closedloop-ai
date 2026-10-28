import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleField } from "./use-inline-edit.test-support";

/**
 * ISS-9588. The title field is always mounted, so its whole commit story runs
 * on blur — and a route change, a host swapping the field out, or a refresh
 * never delivers that blur. Each case here drives one of those instead.
 *
 * `TitleField` mirrors `EditableProjectTitle` and `EditableDocumentTitle`
 * exactly on the point that matters: Enter saves WITHOUT blurring, so the blur
 * that follows is a second pass over the same edit while the first mutation is
 * still in flight.
 */

afterEach(cleanup);

describe("PRD-722 AC-5 DT-032 useInlineEdit across a host transition", () => {
  it("sends one mutation when Enter is followed by a blur", () => {
    // Never settles: this is the window where the saved title has not been
    // handed back down yet, which is the only window the bug lived in.
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    render(<TitleField onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    expect(onSave).toHaveBeenCalledWith(
      "Plan v2",
      "Plan",
      expect.any(Function)
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("commits the typed title when the host unmounts before any blur", () => {
    const onSave = vi.fn(() => Promise.resolve());
    const { unmount } = render(<TitleField onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });

    expect(onSave).not.toHaveBeenCalled();

    unmount();

    expect(onSave).toHaveBeenCalledWith(
      "Plan v2",
      "Plan",
      expect.any(Function)
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("leaves a cancelled edit uncommitted when the host unmounts", () => {
    const onSave = vi.fn(() => Promise.resolve());
    const { unmount } = render(<TitleField onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    // Pins that the typing landed, so the absence below is Escape working and
    // not the edit never happening.
    expect(input).toHaveValue("Plan v2");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("Plan");

    unmount();

    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not let Escape write an older title back over one saved in flight", async () => {
    const save = deferredSave();
    const { unmount } = render(<TitleField onSave={save.onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    // Enter saves WITHOUT blurring, so the field is still live while "Plan v2"
    // is in flight and the hook's `value` still says "Plan".
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Plan v3" } });
    fireEvent.keyDown(input, { key: "Escape" });

    // Escape discards what was typed since the last commit, which is "Plan v2".
    expect(input).toHaveValue("Plan v2");

    await act(() => save.settle());
    unmount();

    expect(save.onSave).toHaveBeenCalledTimes(1);
    expect(save.onSave).toHaveBeenCalledWith(
      "Plan v2",
      "Plan",
      expect.any(Function)
    );
  });

  it("PRD-722 DT-033 keeps empty validation beside the focused draft without writing", async () => {
    const save = deferredSave();
    const { unmount } = render(<TitleField onSave={save.onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // ISS-9490: validation retains the draft and announces the live feedback.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");
    const messageId = input.getAttribute("aria-describedby");
    if (!messageId) {
      throw new Error("Validated title input has no described-by message");
    }
    expect(document.getElementById(messageId)).toHaveTextContent(
      "Title cannot be empty"
    );
    expect(document.getElementById(messageId)).toHaveAttribute("role", "alert");

    await act(() => save.settle());
    unmount();

    expect(save.onSave).toHaveBeenCalledTimes(1);
    expect(save.onSave).toHaveBeenCalledWith(
      "Plan v2",
      "Plan",
      expect.any(Function)
    );
  });

  it("PRD-722 DT-033 DT-034 keeps and marks a refused draft for correction and retry", async () => {
    const onSave = vi
      .fn<
        (
          trimmedValue: string,
          expectedValue: string | undefined
        ) => Promise<unknown>
      >()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue(undefined);
    render(<TitleField onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    fireEvent.blur(input);

    // The dedupe must not outlive the commit it deduped: a refusal puts the
    // baseline back, or the identical retry reads as "unchanged" and is
    // swallowed with nothing on screen saying the title never saved.
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(input).toHaveValue("Plan v2");
      expect(input).toHaveFocus();
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(
        INLINE_EDIT_SAVE_ERROR_MESSAGE
      );
    });

    fireEvent.blur(input);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith(
      "Plan v2",
      "Plan",
      expect.any(Function)
    );
  });

  it("does not steal focus when a refusal settles after the user moves on", async () => {
    let rejectSave: (reason: unknown) => void = () => undefined;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    const onSave = vi.fn<
      (
        next: string,
        expected: string | undefined,
        recoverableErrorOwner?: () => boolean
      ) => Promise<void>
    >(() => pending);
    render(
      <>
        <TitleField onSave={onSave} />
        <input aria-label="Next field" />
      </>
    );

    const title = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Plan v2" } });
    fireEvent.blur(title);
    const next = screen.getByRole("textbox", { name: "Next field" });
    next.focus();

    rejectSave(new Error("refused"));
    await act(async () => pending.catch(() => undefined));

    expect(next).toHaveFocus();
    expect(title).not.toHaveFocus();
    expect(title).toHaveValue("Plan v2");
    expect(title).toHaveAttribute("aria-invalid", "true");
  });

  it("does not steal focus when blur validation follows a move to another control", () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <>
        <TitleField onSave={onSave} />
        <button type="button">Next</button>
      </>
    );
    const title = screen.getByRole("textbox", { name: "Title" });
    const next = screen.getByRole("button", { name: "Next" });

    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "" } });
    fireEvent.blur(title, { relatedTarget: next });
    act(() => next.focus());

    expect(next).toHaveFocus();
    expect(title).not.toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Title cannot be empty"
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("PRD-722 DT-062 clears a retained error when the draft returns to confirmation", async () => {
    const onSave = vi.fn(() => Promise.reject(new Error("refused")));
    render(<TitleField onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    input.blur();
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(input).toHaveAccessibleDescription(INLINE_EDIT_SAVE_ERROR_MESSAGE);

    fireEvent.change(input, { target: { value: "Plan" } });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    input.blur();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("Plan");
  });

  it("PRD-722 DT-035 keeps a newer refused title failed after an older acceptance", async () => {
    const settlers: {
      reject: (reason: unknown) => void;
      resolve: () => void;
    }[] = [];
    const onSave = vi.fn<
      (trimmedValue: string, expectedValue: string | undefined) => Promise<void>
    >(
      () =>
        new Promise<void>((resolve, reject) => {
          settlers.push({ reject, resolve });
        })
    );
    render(<TitleField onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Plan v3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [older, newer] = onSave.mock.results.map((entry) => entry.value);

    settlers[1].reject(new Error("newer refused"));
    await act(async () => newer.catch(() => undefined));
    settlers[0].resolve();
    await act(async () => older);

    expect(input).toHaveValue("Plan v3");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
  });

  it("re-sends on teardown the typing a refused save kept", async () => {
    const onSave = vi
      .fn<
        (
          trimmedValue: string,
          expectedValue: string | undefined
        ) => Promise<unknown>
      >()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue(undefined);
    const { unmount } = render(<TitleField onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    fireEvent.blur(input);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue("Plan v2");

    unmount();

    // The opposite of `InlineScalarCell`, which is back on the old value by
    // now: the field kept the typing, so the transition is the retry the next
    // blur would have been.
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith(
      "Plan v2",
      "Plan",
      expect.any(Function)
    );
  });

  it("commits a retained entity-A draft through A before the mounted host moves to B", async () => {
    const saveA = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(undefined);
    const saveB = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <TitleField initialTitle="Entity A" onSave={saveA} scopeKey="entity-a" />
    );

    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Rejected A draft" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));

    rerender(
      <TitleField initialTitle="Entity B" onSave={saveB} scopeKey="entity-b" />
    );

    await waitFor(() => expect(input).toHaveValue("Entity B"));
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(input);
    expect(saveB).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Entity B revised" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(saveB).toHaveBeenCalledExactlyOnceWith(
      "Entity B revised",
      "Entity B",
      expect.any(Function)
    );
    expect(saveA).toHaveBeenCalledTimes(2);
    expect(saveA).toHaveBeenLastCalledWith("Rejected A draft", "Entity A");
  });

  it("commits dirty entity-A typing through A before a no-blur switch to B", () => {
    const saveA = vi.fn(() => Promise.resolve());
    const saveB = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <TitleField initialTitle="Entity A" onSave={saveA} scopeKey="entity-a" />
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Entity A revised" },
    });
    rerender(
      <TitleField initialTitle="Entity B" onSave={saveB} scopeKey="entity-b" />
    );

    expect(saveA).toHaveBeenCalledExactlyOnceWith(
      "Entity A revised",
      "Entity A"
    );
    expect(saveB).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Entity B"
    );
  });

  it("hands a dirty host's unmount save an owner probe that reports no feedback owner", () => {
    const onSave = vi.fn<
      (
        value: string,
        expected: string | undefined,
        owner?: () => boolean
      ) => Promise<void>
    >(() => Promise.reject(new Error("refused")));
    const { unmount } = render(<TitleField onSave={onSave} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Plan v2" },
    });
    unmount();

    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      "Plan v2",
      "Plan",
      expect.any(Function)
    );
    const owner = onSave.mock.calls[0][2];
    // No field remains to render the refusal, so the mutation's toast must.
    expect(owner?.()).toBe(false);
  });

  it("releases a live attempt's adjacent-feedback ownership on unmount", async () => {
    let rejectSave: (reason: unknown) => void = () => undefined;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    const onSave = vi.fn<
      (
        next: string,
        expected: string | undefined,
        recoverableErrorOwner?: () => boolean
      ) => Promise<void>
    >(() => pending);
    const { unmount } = render(<TitleField onSave={onSave} />);
    const input = screen.getByRole("textbox", { name: "Title" });

    fireEvent.change(input, { target: { value: "Plan v2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const recoverableErrorOwner = onSave.mock.calls[0]?.[2];
    expect(recoverableErrorOwner?.()).toBe(true);

    unmount();
    expect(recoverableErrorOwner?.()).toBe(false);
    rejectSave(new Error("late refusal"));
    await act(async () => pending.catch(() => undefined));
  });

  it("PRD-722 DT-054 ignores an entity-A rejection that settles after entity B mounts", async () => {
    let rejectA: (reason: unknown) => void = () => undefined;
    const pendingA = new Promise<void>((_resolve, reject) => {
      rejectA = reject;
    });
    const saveA = vi.fn(() => pendingA);
    const saveB = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <TitleField initialTitle="Entity A" onSave={saveA} scopeKey="entity-a" />
    );

    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Pending A draft" } });
    fireEvent.keyDown(input, { key: "Enter" });
    rerender(
      <TitleField initialTitle="Entity B" onSave={saveB} scopeKey="entity-b" />
    );
    await waitFor(() => expect(input).toHaveValue("Entity B"));

    rejectA(new Error("late A rejection"));
    await act(async () => pendingA.catch(() => undefined));

    expect(input).toHaveValue("Entity B");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(input, { target: { value: "Entity B revised" } });
    fireEvent.blur(input);
    expect(saveB).toHaveBeenCalledExactlyOnceWith(
      "Entity B revised",
      "Entity B",
      expect.any(Function)
    );
  });

  it("force-resets scope B when its value equals scope A's pending draft", async () => {
    let rejectA: (reason: unknown) => void = () => undefined;
    const pendingA = new Promise<void>((_resolve, reject) => {
      rejectA = reject;
    });
    const saveA = vi.fn(() => pendingA);
    const saveB = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <TitleField initialTitle="Entity A" onSave={saveA} scopeKey="entity-a" />
    );
    const input = screen.getByRole("textbox", { name: "Title" });

    fireEvent.change(input, { target: { value: "Shared value" } });
    fireEvent.keyDown(input, { key: "Enter" });
    rerender(
      <TitleField
        initialTitle="Shared value"
        onSave={saveB}
        scopeKey="entity-b"
      />
    );
    await waitFor(() => expect(input).toHaveValue("Shared value"));

    rejectA(new Error("late A rejection"));
    await act(async () => pendingA.catch(() => undefined));

    fireEvent.change(input, { target: { value: "Entity B revised" } });
    fireEvent.blur(input);
    expect(saveB).toHaveBeenCalledExactlyOnceWith(
      "Entity B revised",
      "Shared value",
      expect.any(Function)
    );
  });

  it("treats a title it was handed untrimmed as untouched, not as an edit", () => {
    const onSave = vi.fn(() => Promise.resolve());
    // Nothing on the write path trims: `normalizeTitle` only collapses
    // newlines, and a title created by the API, an agent, or the new-document
    // dialog never passes through this hook at all.
    const { unmount } = render(
      <TitleField initialTitle="Plan " onSave={onSave} />
    );

    // Not one keystroke has happened, so the field owes the user no warning...
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);

    unmount();

    // ...and owes the server no write. A PATCH here fires on every page visit.
    expect(onSave).not.toHaveBeenCalled();
  });

  it("still commits an edit to a title it was handed untrimmed", () => {
    const onSave = vi.fn(() => Promise.resolve());
    const { unmount } = render(
      <TitleField initialTitle="Plan " onSave={onSave} />
    );

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });

    // The same fixture as the case above, so "untouched" cannot have been
    // bought by making the field deaf.
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    unmount();

    // The expected value is the title as handed, untrimmed: the server
    // compares it byte for byte with the stored one (ISS-11198).
    expect(onSave).toHaveBeenCalledWith(
      "Plan v2",
      "Plan ",
      expect.any(Function)
    );
  });

  it("goes quiet after typing that the blur path declines to save", () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<TitleField onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    // A trailing space is a real edit to the raw field and no edit at all once
    // trimmed, so blur declines to save it and nothing ever resyncs the draft.
    fireEvent.change(input, { target: { value: "Plan " } });
    fireEvent.blur(input);

    expect(onSave).not.toHaveBeenCalled();
    // The warning has to agree with that refusal, or it can never be cleared.
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it("does not commit an edit a dismissing host cancelled in the same batch", () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<DismissOnEscape onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    // One Escape, two handlers: the field reverts its draft and the host tears
    // the field down. React batches both, so the revert never renders.
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not warn about a refresh once the edit has been committed", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<TitleField onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(dispatchBeforeUnload().defaultPrevented).toBe(false)
    );
  });
});

/** A save that stays in flight until the test settles it. */
function deferredSave() {
  let resolve: () => void = () => undefined;
  const settled = new Promise<void>((settle) => {
    resolve = settle;
  });
  return {
    onSave: vi.fn(() => settled),
    settle: () => {
      resolve();
      return settled;
    },
  };
}

/** Dispatches the real event and reports whether anything asked to block it. */
function dispatchBeforeUnload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  globalThis.window.dispatchEvent(event);
  return event;
}

/**
 * A host that dismisses on the same Escape the field cancels on — a dialog, a
 * popover, any ancestor listening for it. Both handlers run in one React batch.
 */
function DismissOnEscape({
  onSave,
}: Readonly<{ onSave: (trimmedValue: string) => Promise<unknown> }>) {
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
      {mounted ? <TitleField onSave={onSave} /> : null}
    </div>
  );
}
