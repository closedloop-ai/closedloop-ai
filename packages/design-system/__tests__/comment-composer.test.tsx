import { CommentComposer } from "@closedloop-ai/design-system/components/ui/comment-composer";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-7349. `CommentComposer` holds a user's typed draft, so every branch here
 * is about not LOSING it. Three rules, each of which fails by silently
 * discarding text a person wrote:
 *
 *  - once the user has typed, a changing `defaultValue` (a background refetch
 *    of the source comment body) must not clobber the in-progress edit;
 *  - `clearOnSubmit: false` keeps the draft for retry when the mutation is
 *    async and the composer stays mounted on failure — wiping it before the
 *    mutation resolves loses the text on every failed submit;
 *  - the submitted body is trimmed, and a whitespace-only draft is not a
 *    submission at all.
 *
 * A story renders the composer empty and enabled. None of the above is
 * reachable from there.
 */

const typeInto = (text: string) =>
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });

const submitButton = () => screen.getByRole("button", { name: "Comment" });

describe("CommentComposer rendering", () => {
  it("names the textarea from its placeholder by default", () => {
    render(<CommentComposer onSubmit={vi.fn()} />);

    expect(
      screen.getByRole("textbox", { name: "Add a comment..." })
    ).toBeInTheDocument();
  });

  it("prefers an explicit aria-label over the placeholder", () => {
    render(<CommentComposer ariaLabel="Reply" onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "Reply" })).toBeInTheDocument();
  });

  it("seeds the draft from defaultValue", () => {
    render(<CommentComposer defaultValue="Seeded" onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox")).toHaveValue("Seeded");
  });

  it("renders no cancel button unless the caller supplies a handler", () => {
    render(<CommentComposer onSubmit={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("renders caller-supplied action labels", () => {
    render(
      <CommentComposer
        cancelLabel="Discard"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        submitLabel="Post"
      />
    );

    expect(screen.getByRole("button", { name: "Post" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("renders helper text and leading actions when supplied", () => {
    render(
      <CommentComposer
        helperText={<span>Markdown supported</span>}
        leadingActions={<button type="button">Attach</button>}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.getByText("Markdown supported")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach" })).toBeInTheDocument();
  });

  it("omits helper text and leading actions when absent", () => {
    render(<CommentComposer onSubmit={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
  });
});

describe("CommentComposer submit gating", () => {
  it("disables submit for an empty draft", () => {
    render(<CommentComposer onSubmit={vi.fn()} />);

    expect(submitButton()).toBeDisabled();
  });

  it("disables submit for a whitespace-only draft", () => {
    render(<CommentComposer onSubmit={vi.fn()} />);

    typeInto("   \n  ");

    expect(submitButton()).toBeDisabled();
  });

  it("enables submit once the draft has content", () => {
    render(<CommentComposer onSubmit={vi.fn()} />);

    typeInto("Looks good");

    expect(submitButton()).toBeEnabled();
  });

  it("submits the TRIMMED body", () => {
    const onSubmit = vi.fn();
    render(<CommentComposer onSubmit={onSubmit} />);

    typeInto("  Looks good  ");
    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith("Looks good");
  });

  it("does not submit while pending", () => {
    const onSubmit = vi.fn();
    render(
      <CommentComposer defaultValue="Ready" isPending onSubmit={onSubmit} />
    );

    fireEvent.click(submitButton());

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit while disabled", () => {
    const onSubmit = vi.fn();
    render(
      <CommentComposer defaultValue="Ready" disabled onSubmit={onSubmit} />
    );

    fireEvent.click(submitButton());

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the textarea while pending", () => {
    render(<CommentComposer isPending onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("disables cancel while pending", () => {
    render(<CommentComposer isPending onCancel={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

describe("CommentComposer keyboard submit", () => {
  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("submits on %s+Enter", (_label, modifier) => {
    const onSubmit = vi.fn();
    render(<CommentComposer defaultValue="Ready" onSubmit={onSubmit} />);

    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      ...modifier,
    });

    expect(onSubmit).toHaveBeenCalledWith("Ready");
  });

  it("does not submit on a bare Enter, so a newline still works", () => {
    const onSubmit = vi.fn();
    render(<CommentComposer defaultValue="Ready" onSubmit={onSubmit} />);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit on a modified key that is not Enter", () => {
    const onSubmit = vi.fn();
    render(<CommentComposer defaultValue="Ready" onSubmit={onSubmit} />);

    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "a",
      metaKey: true,
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("CommentComposer uncontrolled draft handling", () => {
  it("clears the draft after submit by default", () => {
    render(<CommentComposer onSubmit={vi.fn()} />);

    typeInto("Sent");
    fireEvent.click(submitButton());

    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("keeps the draft for retry when the caller opts out of clearing", () => {
    // The async-mutation case: wiping before the mutation resolves loses the
    // text on every failed submit.
    render(<CommentComposer clearOnSubmit={false} onSubmit={vi.fn()} />);

    typeInto("Might fail");
    fireEvent.click(submitButton());

    expect(screen.getByRole("textbox")).toHaveValue("Might fail");
  });

  it("re-seeds from a changed defaultValue while the draft is untouched", () => {
    const { rerender } = render(
      <CommentComposer defaultValue="First" onSubmit={vi.fn()} />
    );

    rerender(<CommentComposer defaultValue="Second" onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox")).toHaveValue("Second");
  });

  it("does NOT clobber an in-progress edit when defaultValue changes", () => {
    // A background refetch of the source comment body must not overwrite what
    // the person is typing.
    const { rerender } = render(
      <CommentComposer defaultValue="First" onSubmit={vi.fn()} />
    );
    typeInto("My edit");

    rerender(<CommentComposer defaultValue="Refetched" onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox")).toHaveValue("My edit");
  });

  it("accepts a later re-seed once the draft has been cleared by a submit", () => {
    // Submitting resets the dirty flag, so the composer is seedable again.
    const { rerender } = render(
      <CommentComposer defaultValue="First" onSubmit={vi.fn()} />
    );
    typeInto("My edit");
    fireEvent.click(submitButton());

    rerender(<CommentComposer defaultValue="Refetched" onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox")).toHaveValue("Refetched");
  });

  it("restores the seeded value on cancel", () => {
    const onCancel = vi.fn();
    render(
      <CommentComposer
        defaultValue="Original"
        onCancel={onCancel}
        onSubmit={vi.fn()}
      />
    );
    typeInto("Edited");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("textbox")).toHaveValue("Original");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("reports every draft change to the caller", () => {
    const onValueChange = vi.fn();
    render(
      <CommentComposer onSubmit={vi.fn()} onValueChange={onValueChange} />
    );

    typeInto("Partial");

    expect(onValueChange).toHaveBeenCalledWith("Partial");
  });

  it("reports the cleared draft after a submit", () => {
    const onValueChange = vi.fn();
    render(
      <CommentComposer onSubmit={vi.fn()} onValueChange={onValueChange} />
    );
    typeInto("Sent");

    fireEvent.click(submitButton());

    expect(onValueChange).toHaveBeenLastCalledWith("");
  });
});

describe("CommentComposer controlled mode", () => {
  it("renders the caller's value", () => {
    render(<CommentComposer onSubmit={vi.fn()} value="From parent" />);

    expect(screen.getByRole("textbox")).toHaveValue("From parent");
  });

  it("does not change the rendered value itself", () => {
    // The parent owns the draft; the composer only reports the intent.
    const onValueChange = vi.fn();
    render(
      <CommentComposer
        onSubmit={vi.fn()}
        onValueChange={onValueChange}
        value="From parent"
      />
    );

    typeInto("Typed");

    expect(onValueChange).toHaveBeenCalledWith("Typed");
    expect(screen.getByRole("textbox")).toHaveValue("From parent");
  });

  it("leaves the value in place after submit, since the parent owns the reset", () => {
    const onSubmit = vi.fn();
    render(<CommentComposer onSubmit={onSubmit} value="From parent" />);

    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith("From parent");
    expect(screen.getByRole("textbox")).toHaveValue("From parent");
  });

  it("ignores clearOnSubmit in controlled mode", () => {
    const onValueChange = vi.fn();
    render(
      <CommentComposer
        clearOnSubmit
        onSubmit={vi.fn()}
        onValueChange={onValueChange}
        value="From parent"
      />
    );

    fireEvent.click(submitButton());

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("does not reset the value on cancel in controlled mode", () => {
    const onValueChange = vi.fn();
    render(
      <CommentComposer
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={onValueChange}
        value="From parent"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onValueChange).not.toHaveBeenCalled();
  });
});
