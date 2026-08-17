/**
 * ISS-4540: event/system rows fold Claude Code harness wrapper tags (e.g.
 * `<local-command-stdout>…</…>`) into collapsible chips through the same
 * `parseTraceParts` splitter the message body uses, so raw XML no longer leaks
 * into the timeline. The event path keeps its `#row` jump links, and plain
 * event lines render unchanged.
 *
 * Real session detail always passes `onJump` (agent-session-detail-view.tsx), so
 * every folding case here mounts SessionTrace WITH `onJump` — the shape that
 * actually ships — and asserts that expanding a chip never fires the row jump.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTrace, type SessionTraceItem } from "../session-trace";

const COMMAND_OUTPUT_LABEL = /Command output/;
const REVIEW_LABEL = /\/review/;
/** A full `/resume` invocation echoed on an event/system line. */
const RESUME_INVOCATION =
  "<command-name>/resume</command-name>\n<command-message>resume</command-message>\n<command-args></command-args>";

// The inline composer picker resolves org members; stub so mounting never
// depends on a live users query.
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

afterEach(() => {
  cleanup();
});

function eventItemWithText(row: number, text: string): SessionTraceItem {
  return {
    type: "event",
    _row: row,
    t: "00:00",
    tMs: row,
    dot: "b",
    text,
  };
}

describe("SessionTrace event/system rows fold harness tags", () => {
  it("collapses a <local-command-stdout> event line into an expandable chip with a friendly label", () => {
    const onJump = vi.fn();
    const { container, getByRole } = render(
      <SessionTrace
        items={[
          eventItemWithText(
            1,
            "<local-command-stdout>secret echo</local-command-stdout>"
          ),
        ]}
        onJump={onJump}
      />
    );

    const chip = container.querySelector(".st-tag");
    expect(chip).not.toBeNull();
    // The chip shows a friendly label, not the raw tag name or the raw XML, and
    // the inner text stays hidden until expanded.
    expect(container.textContent).toContain("Command output");
    expect(container.textContent).not.toContain("<local-command-stdout>");
    expect(container.textContent).not.toContain("local-command-stdout");
    expect(container.textContent).not.toContain("secret echo");

    fireEvent.click(getByRole("button", { name: COMMAND_OUTPUT_LABEL }));
    expect(container.textContent).toContain("secret echo");
    // Expanding the chip must never bubble a timeline jump, even though real
    // session detail always passes onJump.
    expect(onJump).not.toHaveBeenCalled();
  });

  it("renders a chip-bearing event as a left-aligned block, not a clickable separator button", () => {
    const { container } = render(
      <SessionTrace
        items={[
          eventItemWithText(
            1,
            "<local-command-stdout>out</local-command-stdout>"
          ),
        ]}
        onJump={vi.fn()}
      />
    );

    const row = container.querySelector('[data-row="1"]');
    expect(row).not.toBeNull();
    // No button-in-a-button: the row itself is not a <button> when it holds a
    // chip, so the chip's own button is the only interactive control in the row.
    expect(row?.tagName).toBe("DIV");
    expect(row?.classList.contains("st-sysline-tag")).toBe(true);
  });

  it("folds a wrapper whose closing tag was truncated upstream instead of leaking the raw opener", () => {
    const { container, getByRole } = render(
      <SessionTrace
        items={[
          eventItemWithText(1, "<local-command-stdout>partial output cut off"),
        ]}
        onJump={vi.fn()}
      />
    );

    expect(container.querySelector(".st-tag")).not.toBeNull();
    // The raw opener never renders even though the closer is missing.
    expect(container.textContent).not.toContain("<local-command-stdout>");
    expect(container.textContent).toContain("Command output");
    expect(container.textContent).not.toContain("partial output cut off");

    fireEvent.click(getByRole("button", { name: COMMAND_OUTPUT_LABEL }));
    expect(container.textContent).toContain("partial output cut off");
  });

  it("keeps #row jump links working in an event row", () => {
    const onJump = vi.fn();
    const { getByRole } = render(
      <SessionTrace
        items={[eventItemWithText(1, "compacted from #42")]}
        onJump={onJump}
      />
    );

    fireEvent.click(getByRole("button", { name: "#42" }));
    expect(onJump).toHaveBeenCalledWith(42);
  });

  it("renders a plain event line unchanged with no chip", () => {
    const { container } = render(
      <SessionTrace items={[eventItemWithText(1, "Stop")]} onJump={vi.fn()} />
    );

    expect(container.querySelector(".st-tag")).toBeNull();
    expect(container.querySelector(".st-sysline-text")?.textContent).toContain(
      "Stop"
    );
  });

  // ISS-4767: a command chip's head is a `<button>` exactly like a wrapper
  // chip's, so the `containsHarnessTag` guard must treat a command-only row the
  // same way — otherwise the row is wrapped in the clickable separator
  // `<button>` and we get a button inside a button.
  it("renders a command-only event as a left-aligned block, not a clickable separator button", () => {
    const onJump = vi.fn();
    const { container, getByRole } = render(
      <SessionTrace
        items={[
          eventItemWithText(
            1,
            "<command-name>/review</command-name>\n<command-message>look at the open comments</command-message>\n<command-args>--fix</command-args>"
          ),
        ]}
        onJump={onJump}
      />
    );

    const row = container.querySelector('[data-row="1"]');
    expect(row).not.toBeNull();
    expect(row?.tagName).toBe("DIV");
    expect(row?.classList.contains("st-sysline-tag")).toBe(true);
    expect(row?.querySelectorAll("button")).toHaveLength(1);
    expect(container.textContent).toContain("/review");

    fireEvent.click(getByRole("button", { name: REVIEW_LABEL }));
    expect(container.textContent).toContain("look at the open comments");
    expect(onJump).not.toHaveBeenCalled();
  });

  // A command-only row with nothing to expand renders no button at all, so the
  // row stays a normal clickable separator — the guard must not over-report.
  it("keeps a command row with no details out of the chip layout", () => {
    const { container } = render(
      <SessionTrace
        items={[eventItemWithText(1, RESUME_INVOCATION)]}
        onJump={vi.fn()}
      />
    );

    const row = container.querySelector('[data-row="1"]');
    // Still folded (so the raw XML never leaks), still not a nested button.
    expect(row?.tagName).toBe("DIV");
    expect(container.textContent).toContain("/resume");
    expect(container.textContent).not.toContain("command-name");
    expect(row?.querySelectorAll("button")).toHaveLength(0);
  });
});
