/**
 * Unit tests for TraceMessageBody: collapses Claude Code harness wrapper tags
 * into expandable chips while rendering surrounding prose as markdown, and
 * leaves tags inside code untouched.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TraceMessageBody } from "../trace-message-body";

const CAVEAT_LABEL = /Caveat/;
const REVIEW_LABEL = /\/review/;
const COMMAND_OUTPUT_LABEL = /Command output/;
/** The verbatim `/resume` turn text captured on session SES-73062. */
const RESUME_INVOCATION =
  "<command-name>/resume</command-name>\n            <command-message>resume</command-message>\n            <command-args></command-args>";

afterEach(() => {
  cleanup();
});

/**
 * ISS-5366 retired the `session-trace-slash-command-chip` gate, so the body
 * folds slash-command invocations on every mount — no flag adapter and no
 * provider between the caller and the rendered chip.
 */
function renderBody(text: string) {
  return render(<TraceMessageBody text={text} />);
}

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
      <TraceMessageBody
        text={"<local-command-caveat>ignore this</local-command-caveat>"}
      />
    );

    const chip = container.querySelector(".st-tag");
    expect(chip).not.toBeNull();
    // A friendly label is shown (not the raw tag name); the inner content is
    // hidden until expanded.
    expect(container.textContent).toContain("Caveat");
    expect(container.textContent).not.toContain("local-command-caveat");
    expect(container.textContent).not.toContain("ignore this");

    fireEvent.click(getByRole("button", { name: CAVEAT_LABEL }));
    expect(container.textContent).toContain("ignore this");
  });

  // ISS-4767: a slash-command turn is ONE fact, not three harness wrappers. A
  // lone `<command-name>` still folds — into a chip that names the command.
  it("folds a lone command-name tag into a chip labelled with the command", () => {
    const { container, queryByRole } = renderBody(
      "<command-name>/clear</command-name>"
    );

    expect(container.querySelector(".st-tag")).not.toBeNull();
    expect(container.textContent).toBe("/clear");
    expect(container.textContent).not.toContain("command-name");
    // Nothing to expand into, so no dead disclosure is offered.
    expect(queryByRole("button")).toBeNull();
    expect(container.querySelector(".st-tag-head-static")).not.toBeNull();
  });

  // ISS-4767: the exact shape reported on SES-73062 — three sibling wrapper
  // tags for one typed `/resume`. Before the fix this rendered as three opaque
  // "Command"/"Command"/"Command arguments" chips that named no command.
  it("renders a full slash-command invocation as one clean command chip", () => {
    const { container, queryByRole } = renderBody(RESUME_INVOCATION);

    expect(container.querySelectorAll(".st-tag")).toHaveLength(1);
    expect(container.textContent).toBe("/resume");
    for (const tagName of ["command-name", "command-message", "command-args"]) {
      expect(container.textContent).not.toContain(tagName);
    }
    // The harness echoes `<command-message>resume</command-message>` for a bare
    // `/resume`; a disclosure that only restates the head is not offered.
    expect(queryByRole("button")).toBeNull();
  });

  // The arguments are half the fact the turn carries, so they ride in the head
  // beside the command — the row reads like the command line the user typed.
  // Only the harness's message, which the head does not say, stays folded.
  it("shows the invocation's arguments in the head, message behind the disclosure", () => {
    const { container, getByRole } = renderBody(
      "<command-name>/review</command-name>\n<command-message>look at the open comments</command-message>\n<command-args>--fix packages/app</command-args>"
    );

    expect(container.querySelector(".st-tag-args")?.textContent).toBe(
      "--fix packages/app"
    );

    const toggle = getByRole("button", { name: REVIEW_LABEL });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("open comments");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("look at the open comments");
    expect(container.textContent).toContain("Message");
    // The head already showed the arguments in full, so they are not repeated.
    expect(container.textContent).not.toContain("Arguments");
  });

  // A long argument string is elided by the head's ellipsis, so the chip must
  // still make the whole value reachable rather than withhold what it hid.
  it("keeps an over-long argument string reachable in the disclosure", () => {
    const args =
      "--fix packages/app --exclude packages/design-system --verbose";
    const { container, getByRole } = renderBody(
      `<command-name>/review</command-name>\n<command-args>${args}</command-args>`
    );

    expect(container.querySelector(".st-tag-args")?.textContent).toBe(args);

    fireEvent.click(getByRole("button", { name: REVIEW_LABEL }));

    expect(container.textContent).toContain("Arguments");
    expect(container.querySelector(".st-tag-body")?.textContent).toContain(
      args
    );
  });

  // wongk (#4248): the body only ever sees `NormalizedMessage.text` after the
  // 4,096-byte cut, which can land inside the invocation's last field. The
  // orphaned tail must stay part of the SAME chip — before this it fell through
  // to the generic unterminated-tag fold and one command rendered as two chips.
  it("renders a truncation-split invocation as one chip, not two", () => {
    const { container } = renderBody(
      "<command-name>/review</command-name>\n<command-args>--fix packages/ap"
    );

    expect(container.querySelectorAll(".st-tag")).toHaveLength(1);
    expect(container.querySelector(".st-tag-name")?.textContent).toBe(
      "/review"
    );
    expect(container.querySelector(".st-tag-args")?.textContent).toBe(
      "--fix packages/ap"
    );
    expect(container.textContent).not.toContain("command-args");
  });

  // A command nested INSIDE a wrapper tag must fold once, via the wrapper's own
  // recursion — never twice, and never by rewinding the splitter's cursor so
  // the wrapper's raw closing tag leaks back out as markdown.
  it("folds a command nested in a wrapper tag exactly once, with no raw closer", () => {
    const { container, getByRole } = renderBody(
      "<local-command-stdout>\n<command-name>/clear</command-name>\n</local-command-stdout>"
    );

    expect(container.querySelectorAll(".st-tag")).toHaveLength(1);
    expect(container.textContent).toBe("Command output");
    expect(container.textContent).not.toContain("</local-command-stdout>");

    fireEvent.click(getByRole("button", { name: COMMAND_OUTPUT_LABEL }));
    expect(container.querySelectorAll(".st-tag")).toHaveLength(2);
    expect(container.textContent).toContain("/clear");
    expect(container.textContent).not.toContain("</local-command-stdout>");
  });

  // ISS-4767 (version skew): a row stored before the harness markup was folded
  // may carry bracket-less debris. It must render as the plain text it is —
  // never crash, and never be pattern-matched into a fabricated command chip.
  it("leaves an already-stripped legacy row as plain text", () => {
    const { container, queryByRole } = renderBody(
      "command-name/resumecommand-messagecommand-args"
    );

    expect(container.querySelector(".st-tag")).toBeNull();
    expect(queryByRole("button")).toBeNull();
    expect(container.textContent).toContain(
      "command-name/resumecommand-messagecommand-args"
    );
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
