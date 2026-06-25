/**
 * Unit tests for TraceMarkdown: parses session-trace message text as markdown
 * while preserving #<row> jump links, and leaves #<row> inside code untouched.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TraceMarkdown } from "../trace-markdown";

afterEach(() => {
  cleanup();
});

describe("TraceMarkdown", () => {
  it("renders markdown structure instead of literal syntax", () => {
    const { container } = render(
      <TraceMarkdown text={"## Heading\n\nSome **bold** and `inline` text."} />
    );

    expect(container.querySelector("h2")?.textContent).toBe("Heading");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("inline");
    // The raw markdown markers must not survive as visible text.
    expect(container.textContent).not.toContain("##");
    expect(container.textContent).not.toContain("**bold**");
  });

  it("turns #<row> references into buttons that call onJump", () => {
    const onJump = vi.fn();
    const { getByRole } = render(
      <TraceMarkdown onJump={onJump} text="See step #12 for details." />
    );

    const button = getByRole("button", { name: "#12" });
    fireEvent.click(button);

    expect(onJump).toHaveBeenCalledWith(12);
  });

  it("renders #<row> as static text when no onJump handler is provided", () => {
    const { container, queryByRole } = render(
      <TraceMarkdown text="See step #7." />
    );

    expect(queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("#7");
  });

  it("does not linkify #<row> inside fenced code", () => {
    const onJump = vi.fn();
    const { container, queryByRole } = render(
      <TraceMarkdown onJump={onJump} text={"```\nfetch(#42)\n```"} />
    );

    // The #42 lives in a code node, so it must stay literal text with no jump
    // button rendered for it.
    expect(queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("#42");
  });

  it("renders real URLs as safe external links", () => {
    const { getByRole } = render(
      <TraceMarkdown text="Visit https://example.com now." />
    );

    const link = getByRole("link", { name: "https://example.com" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });
});
