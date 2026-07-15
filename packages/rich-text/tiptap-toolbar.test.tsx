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

function createEditorMock(previousHref?: string) {
  const chain = {
    extendMarkRange: vi.fn(() => chain),
    unsetLink: vi.fn(() => chain),
    setLink: vi.fn(() => chain),
    run: vi.fn(() => chain),
  };
  const editor = {
    getAttributes: vi.fn(() => ({ href: previousHref })),
    chain: vi.fn(() => chain),
    can: vi.fn(() => ({ undo: () => false, redo: () => false })),
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
