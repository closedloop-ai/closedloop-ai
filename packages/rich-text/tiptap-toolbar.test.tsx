// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TiptapToolbar } from "./tiptap-toolbar";

vi.mock("@repo/design-system/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: Readonly<{
    children: ReactNode;
    variant?: string;
    size?: string;
    asChild?: boolean;
  }>) => <button {...props}>{children}</button>,
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  Tooltip: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
}));

function createEditorMock(
  previousHref?: string,
  selection = { from: 1, to: 1 }
) {
  const chain = {
    extendMarkRange: vi.fn(() => chain),
    unsetLink: vi.fn(() => chain),
    setLink: vi.fn(() => chain),
    run: vi.fn(() => chain),
  };
  const editor = {
    getAttributes: vi.fn(() => ({ href: previousHref })),
    chain: vi.fn(() => chain),
    can: vi.fn((): { undo: () => boolean; redo: () => boolean } => ({
      undo: () => false,
      redo: () => false,
    })),
    state: { selection },
    on: vi.fn(),
    off: vi.fn(),
  };
  return { chain, editor };
}

function clickLink(previousHref?: string) {
  const { chain, editor } = createEditorMock(previousHref);
  render(<TiptapToolbar editor={editor as unknown as Editor} />);
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
  return chain;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TiptapToolbar toggleLink", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => null)
    );
  });

  it("sets the link for an accepted URL", () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "https://example.com")
    );

    const chain = clickLink();

    expect(chain.extendMarkRange).toHaveBeenCalledWith("link");
    expect(chain.setLink).toHaveBeenCalledWith({ href: "https://example.com" });
    expect(chain.unsetLink).not.toHaveBeenCalled();
    expect(chain.run).toHaveBeenCalled();
  });

  it("unsets the link on empty input", () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "")
    );

    const chain = clickLink("https://existing.example.com");

    expect(chain.extendMarkRange).toHaveBeenCalledWith("link");
    expect(chain.unsetLink).toHaveBeenCalled();
    expect(chain.setLink).not.toHaveBeenCalled();
  });

  it("never sets a link for whitespace-only input", () => {
    // Whitespace-only input is never stored as an href; it either clears the
    // link or is skipped, but setLink must not fire. (Asserting only the
    // invariant keeps this test stable across the toolbar's unset/skip
    // handling of whitespace.)
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "   ")
    );

    const chain = clickLink();

    expect(chain.setLink).not.toHaveBeenCalled();
  });

  it("does nothing when the prompt is cancelled", () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => null)
    );

    const chain = clickLink("https://existing.example.com");

    expect(chain.setLink).not.toHaveBeenCalled();
    expect(chain.unsetLink).not.toHaveBeenCalled();
  });

  it("skips a rejected (unsafe-scheme) URL without setting or unsetting", () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "javascript:alert(1)")
    );

    const chain = clickLink();

    expect(chain.setLink).not.toHaveBeenCalled();
    expect(chain.unsetLink).not.toHaveBeenCalled();
  });
});

describe("TiptapToolbar inline comments", () => {
  it("enables Add Comment only when text is selected", () => {
    const onAddComment = vi.fn();
    const collapsed = createEditorMock(undefined, { from: 2, to: 2 });
    const selected = createEditorMock(undefined, { from: 2, to: 8 });
    const { rerender } = render(
      <TiptapToolbar
        editor={collapsed.editor as unknown as Editor}
        onAddComment={onAddComment}
      />
    );

    expect(
      screen
        .getByRole("button", { name: "Add Comment" })
        .hasAttribute("disabled")
    ).toBe(true);

    rerender(
      <TiptapToolbar
        editor={selected.editor as unknown as Editor}
        onAddComment={onAddComment}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Comment" }));

    expect(onAddComment).toHaveBeenCalledOnce();
  });
});

describe("TiptapToolbar editor state", () => {
  it("keeps Undo and Redo disabled and subscribes to nothing when there is no editor", () => {
    render(<TiptapToolbar editor={null} />);

    expect(
      screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Redo" }).hasAttribute("disabled")
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Insert Image" })).toBeNull();
  });

  it("enables Undo and Redo from editor.can() and unsubscribes on unmount", () => {
    const { editor } = createEditorMock();
    editor.can = vi.fn(() => ({ undo: () => true, redo: () => true }));
    const { unmount } = render(
      <TiptapToolbar editor={editor as unknown as Editor} />
    );

    expect(
      screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Redo" }).hasAttribute("disabled")
    ).toBe(false);
    expect(editor.on).toHaveBeenCalledWith("transaction", expect.any(Function));

    const listener = editor.on.mock.calls[0]?.[1];
    unmount();
    expect(editor.off).toHaveBeenCalledWith("transaction", listener);
  });

  it("disables every control and hides Insert Image in read-only mode", () => {
    const { editor } = createEditorMock(undefined, { from: 1, to: 5 });
    editor.can = vi.fn(() => ({ undo: () => true, redo: () => true }));
    Object.assign(editor, { insertInlineImageFile: vi.fn() });
    render(
      <TiptapToolbar
        editor={editor as unknown as Editor}
        hasLiveblocksExtension
        onPasteMarkdown={vi.fn()}
        onUploadInlineImage={vi.fn()}
        readOnly
      />
    );

    for (const name of READ_ONLY_GATED_CONTROLS) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled")
      ).toBe(true);
    }
    expect(screen.queryByRole("button", { name: "Insert Image" })).toBeNull();
  });
});

describe("TiptapToolbar optional controls", () => {
  it("omits Paste Markdown and Add Comment when no handler or Liveblocks is present", () => {
    const { editor } = createEditorMock();
    render(<TiptapToolbar editor={editor as unknown as Editor} />);

    expect(screen.queryByRole("button", { name: "Paste Markdown" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Comment" })).toBeNull();
  });

  it("calls onPasteMarkdown when Paste Markdown is clicked", () => {
    const { editor } = createEditorMock();
    const onPasteMarkdown = vi.fn();
    render(
      <TiptapToolbar
        editor={editor as unknown as Editor}
        onPasteMarkdown={onPasteMarkdown}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Paste Markdown" }));

    expect(onPasteMarkdown).toHaveBeenCalledOnce();
  });

  it("routes Add Comment to the Liveblocks addPendingComment command", () => {
    const { editor } = createEditorMock(undefined, { from: 1, to: 4 });
    const addPendingComment = vi.fn();
    Object.assign(editor, { commands: { addPendingComment } });
    render(
      <TiptapToolbar
        editor={editor as unknown as Editor}
        hasLiveblocksExtension
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Comment" }));

    expect(addPendingComment).toHaveBeenCalledOnce();
  });

  it("treats a missing addPendingComment command as a no-op", () => {
    const { editor } = createEditorMock(undefined, { from: 1, to: 4 });
    Object.assign(editor, { commands: {} });
    render(
      <TiptapToolbar
        editor={editor as unknown as Editor}
        hasLiveblocksExtension
      />
    );

    // React 19 reports a handler error through window "error" instead of
    // rethrowing, so a throw from the click shows up only on that event.
    const handlerErrors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      handlerErrors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Add Comment" }));
    } finally {
      window.removeEventListener("error", onError);
    }

    expect(handlerErrors).toEqual([]);
  });
});

describe("TiptapToolbar inline image upload", () => {
  function fileInput(): HTMLInputElement {
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("file input not rendered");
    }
    return input;
  }

  it("falls back to the editor's insertInlineImageFile when no upload prop is given", () => {
    const { editor } = createEditorMock();
    const insertInlineImageFile = vi.fn();
    Object.assign(editor, { insertInlineImageFile });
    render(<TiptapToolbar editor={editor as unknown as Editor} />);

    const file = new File(["x"], "a.png", { type: "image/png" });
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(insertInlineImageFile).toHaveBeenCalledWith(file);
  });

  it("prefers onUploadInlineImage and ignores an empty file selection", () => {
    const { editor } = createEditorMock();
    const insertInlineImageFile = vi.fn();
    Object.assign(editor, { insertInlineImageFile });
    const onUploadInlineImage = vi.fn();
    render(
      <TiptapToolbar
        editor={editor as unknown as Editor}
        onUploadInlineImage={onUploadInlineImage}
      />
    );

    fireEvent.change(fileInput(), { target: { files: [] } });
    expect(onUploadInlineImage).not.toHaveBeenCalled();

    const file = new File(["x"], "b.png", { type: "image/png" });
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(onUploadInlineImage).toHaveBeenCalledWith(file);
    expect(insertInlineImageFile).not.toHaveBeenCalled();
  });

  it("opens the hidden file picker from Insert Image", () => {
    const { editor } = createEditorMock();
    render(
      <TiptapToolbar
        editor={editor as unknown as Editor}
        onUploadInlineImage={vi.fn()}
      />
    );
    const click = vi.spyOn(fileInput(), "click");

    fireEvent.click(screen.getByRole("button", { name: "Insert Image" }));

    expect(click).toHaveBeenCalledOnce();
  });
});

const READ_ONLY_GATED_CONTROLS = [
  "Undo",
  "Redo",
  "Heading 1",
  "Heading 2",
  "Heading 3",
  "Bold",
  "Italic",
  "Inline Code",
  "Bullet List",
  "Numbered List",
  "Blockquote",
  "Link",
  "Insert Table",
  "Insert Mermaid Diagram",
  "Paste Markdown",
  "Add Comment",
] as const;
