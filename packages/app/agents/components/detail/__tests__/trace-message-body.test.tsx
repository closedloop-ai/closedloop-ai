/**
 * Unit tests for TraceMessageBody: collapses Claude Code harness wrapper tags
 * into expandable chips while rendering surrounding prose as markdown, and
 * leaves tags inside code untouched.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TraceMessageBody } from "../trace-message-body";

const COMMAND_NAME_LABEL = /command-name/;

afterEach(() => {
  cleanup();
});

describe("TraceMessageBody", () => {
  it("renders plain prose without any chip", () => {
    const { container, queryByRole } = render(
      <TraceMessageBody text="Just some **normal** prose." />
    );

    expect(container.querySelector("span div")).toBeNull();
    expect(container.querySelector(".st-tag")).toBeNull();
    expect(queryByRole("button")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("normal");
  });

  it("keeps markdown selection metadata on valid block wrappers", () => {
    const { container } = render(
      <TraceMessageBody
        text="Just some **normal** prose."
        traceHighlight={{ kind: "exact", startOffset: 10, endOffset: 16 }}
        traceId="trace:s1:1"
        traceRow={1}
        traceSelectionEnabled
        traceSessionId="s1"
        traceTurnId="turn:stable"
      />
    );

    const selectionRoot = container.querySelector("[data-trace-text-row]");
    expect(selectionRoot?.tagName).toBe("DIV");
    expect(selectionRoot?.getAttribute("data-trace-id")).toBe("trace:s1:1");
    expect(selectionRoot?.getAttribute("data-trace-turn-id")).toBe(
      "turn:stable"
    );
    expect(
      container.querySelector("[data-trace-selected-passage]")?.textContent
    ).toBe("normal");
    expect(container.querySelector("span div")).toBeNull();
  });

  it("collapses a harness wrapper tag into an expandable chip", () => {
    const { container, getByRole } = render(
      <TraceMessageBody text={"<command-name>/clear</command-name>"} />
    );

    const chip = container.querySelector(".st-tag");
    expect(chip).not.toBeNull();
    // The tag name is shown; the inner content is hidden until expanded.
    expect(container.textContent).toContain("command-name");
    expect(container.textContent).not.toContain("/clear");

    fireEvent.click(getByRole("button", { name: COMMAND_NAME_LABEL }));
    expect(container.textContent).toContain("/clear");
  });

  it("renders prose around a harness tag and keeps it out of the chip", () => {
    const { container } = render(
      <TraceMessageBody
        text={
          "<command-args></command-args>\n\nresolve the comments on https://example.com/pull/1748"
        }
      />
    );

    expect(container.querySelector(".st-tag")).not.toBeNull();
    // Surrounding prose still renders as a link, outside the collapsed chip.
    const link = container.querySelector("a.st-ext-link");
    expect(link?.getAttribute("href")).toBe("https://example.com/pull/1748");
  });

  it("does not collapse tags that appear inside fenced code", () => {
    const { container, queryByRole } = render(
      <TraceMessageBody text={"```\n<command-name>x</command-name>\n```"} />
    );

    expect(container.querySelector(".st-tag")).toBeNull();
    expect(queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("<command-name>");
  });
});
