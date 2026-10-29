// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiEmailInviteField } from "../multi-email-invite-field";

const WORK_EMAILS = { name: "Work emails" } as const;
const SEND_BUTTON = /Send/;
const PARSE_ERROR = /^Check /;
const EMPTY_PLACEHOLDER =
  "Paste a list of emails, separated by commas or new lines";
const NEXT_PLACEHOLDER = "Add another";

/**
 * ISS-8348 acceptance criteria for the reusable composer: pasted/comma/newline
 * input with duplicates and malformed domains handled accessibly, and no
 * onboarding coupling, so Settings can mount it on its own.
 */
describe("MultiEmailInviteField", () => {
  it("splits typed input on commas and spaces, and dedupes case-insensitively", () => {
    const onSubmit = vi.fn();
    render(<MultiEmailInviteField onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox", WORK_EMAILS), {
      target: { value: "a@x.com, b@x.com A@X.com c@x.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: SEND_BUTTON }));

    expect(onSubmit).toHaveBeenCalledWith(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("splits a NEWLINE-separated list pasted from a spreadsheet", () => {
    // Newlines only ever reach this field through the clipboard: a single-line
    // `<input>` strips CR/LF from `value` on the way in, so the paste handler is
    // the whole newline path, not a convenience over the typed one.
    const onSubmit = vi.fn();
    render(<MultiEmailInviteField onSubmit={onSubmit} />);

    fireEvent.paste(screen.getByRole("textbox", WORK_EMAILS), {
      clipboardData: {
        getData: () => "a@x.com\nb@x.com\r\nA@X.com\nc@x.com",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: SEND_BUTTON }));

    expect(onSubmit).toHaveBeenCalledWith(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("names a malformed domain in a live region and blocks the send", () => {
    const onSubmit = vi.fn();
    render(<MultiEmailInviteField onSubmit={onSubmit} />);

    const input = screen.getByRole("textbox", WORK_EMAILS);
    fireEvent.change(input, { target: { value: "good@x.com, nope@bad " } });

    expect(screen.getByText("Check nope@bad")).not.toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: SEND_BUTTON }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("removes a recipient through an accessibly-named control", () => {
    const onSubmit = vi.fn();
    render(<MultiEmailInviteField onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox", WORK_EMAILS), {
      target: { value: "a@x.com, b@x.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove a@x.com" }));
    fireEvent.click(screen.getByRole("button", { name: SEND_BUTTON }));

    expect(onSubmit).toHaveBeenCalledWith(["b@x.com"]);
  });

  it("keeps two instances on one page independently labelled", () => {
    render(
      <>
        <MultiEmailInviteField onSubmit={vi.fn()} />
        <MultiEmailInviteField onSubmit={vi.fn()} />
      </>
    );

    // The ids were module-level constants, so both labels pointed at whichever
    // input mounted first — the collision that blocked Settings reuse.
    const inputs = screen.getAllByRole("textbox", WORK_EMAILS);
    expect(inputs).toHaveLength(2);
    const ids = inputs.map((input) => input.getAttribute("id"));
    expect(new Set(ids).size).toBe(2);
  });

  it("is inert while a send is pending", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <MultiEmailInviteField onSubmit={onSubmit} pending={false} />
    );

    fireEvent.change(screen.getByRole("textbox", WORK_EMAILS), {
      target: { value: "a@x.com " },
    });
    rerender(<MultiEmailInviteField onSubmit={onSubmit} pending />);

    fireEvent.click(screen.getByRole("button", { name: "Sending…" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("reports a send failure without marking valid input invalid", () => {
    render(
      <MultiEmailInviteField
        onSubmit={vi.fn()}
        submissionError="Invite service down"
      />
    );

    const input = screen.getByRole("textbox", WORK_EMAILS);
    fireEvent.change(input, { target: { value: "a@x.com " } });

    expect(screen.getByText("Invite service down")).not.toBeNull();
    // A server rejection is not a parse error; the addresses are still valid.
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(screen.queryByText(PARSE_ERROR)).toBeNull();
  });
});

function chipNames(): string[] {
  return screen
    .queryAllByRole("button", { name: REMOVE_BUTTON })
    .map((button) => button.getAttribute("aria-label") ?? "");
}

const REMOVE_BUTTON = /^Remove /;

describe("MultiEmailInviteField keyboard and draft handling", () => {
  it.each(["Enter", ",", ";"])(
    "commits a valid draft on %s and clears the input",
    (key) => {
      render(<MultiEmailInviteField onSubmit={vi.fn()} />);
      const input = screen.getByRole("textbox", WORK_EMAILS);
      expect(input.getAttribute("placeholder")).toBe(EMPTY_PLACEHOLDER);

      fireEvent.change(input, { target: { value: "a@x.com" } });
      fireEvent.keyDown(input, { key });

      expect(chipNames()).toEqual(["Remove a@x.com"]);
      expect((input as HTMLInputElement).value).toBe("");
      expect(input.getAttribute("placeholder")).toBe(NEXT_PLACEHOLDER);
      expect(
        screen.getByRole("button", { name: SEND_BUTTON }).textContent
      ).toBe("Send invite");
    }
  );

  it("keeps an invalid draft in the input and names it on Enter", () => {
    render(<MultiEmailInviteField onSubmit={vi.fn()} />);
    const input = screen.getByRole("textbox", WORK_EMAILS);

    fireEvent.change(input, { target: { value: "nope@bad" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(chipNames()).toEqual([]);
    expect((input as HTMLInputElement).value).toBe("nope@bad");
    expect(screen.getByText("Check nope@bad")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: SEND_BUTTON }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("leaves everything unchanged on Enter with an empty draft", () => {
    render(<MultiEmailInviteField onSubmit={vi.fn()} />);
    const input = screen.getByRole("textbox", WORK_EMAILS);

    fireEvent.keyDown(input, { key: "Enter" });

    expect(chipNames()).toEqual([]);
    expect(screen.queryByText(PARSE_ERROR)).toBeNull();
    expect(
      screen.getByRole("button", { name: SEND_BUTTON }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("removes the last recipient on Backspace only when the draft is empty", () => {
    render(<MultiEmailInviteField onSubmit={vi.fn()} />);
    const input = screen.getByRole("textbox", WORK_EMAILS);
    fireEvent.change(input, { target: { value: "a@x.com b@x.com " } });
    expect(chipNames()).toEqual(["Remove a@x.com", "Remove b@x.com"]);
    expect(screen.getByRole("button", { name: SEND_BUTTON }).textContent).toBe(
      "Send 2 invites"
    );

    fireEvent.change(input, { target: { value: "c" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(chipNames()).toEqual(["Remove a@x.com", "Remove b@x.com"]);

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(chipNames()).toEqual(["Remove a@x.com"]);
  });

  it("keeps the unfinished trailing word as the draft while typing", () => {
    render(<MultiEmailInviteField onSubmit={vi.fn()} />);
    const input = screen.getByRole("textbox", WORK_EMAILS);

    fireEvent.change(input, { target: { value: "a@x.com b@x" } });

    expect(chipNames()).toEqual(["Remove a@x.com"]);
    expect((input as HTMLInputElement).value).toBe("b@x");
    expect(screen.queryByText(PARSE_ERROR)).toBeNull();
  });

  it("commits the draft on blur", () => {
    render(<MultiEmailInviteField onSubmit={vi.fn()} />);
    const input = screen.getByRole("textbox", WORK_EMAILS);

    fireEvent.change(input, { target: { value: "a@x.com" } });
    fireEvent.blur(input);

    expect(chipNames()).toEqual(["Remove a@x.com"]);
  });

  it("leaves a single pasted address to the browser's default insert", () => {
    render(<MultiEmailInviteField onSubmit={vi.fn()} />);
    const input = screen.getByRole("textbox", WORK_EMAILS);

    const notPrevented = fireEvent.paste(input, {
      clipboardData: { getData: () => "a@x.com" },
    });

    expect(notPrevented).toBe(true);
    expect(chipNames()).toEqual([]);
  });

  it("keeps invalid pasted addresses in the draft and names them", () => {
    render(<MultiEmailInviteField onSubmit={vi.fn()} />);
    const input = screen.getByRole("textbox", WORK_EMAILS);
    fireEvent.change(input, { target: { value: "a@x.com" } });

    fireEvent.paste(input, {
      clipboardData: { getData: () => "nope@bad\nb@x.com" },
    });

    expect(chipNames()).toEqual(["Remove a@x.com", "Remove b@x.com"]);
    expect((input as HTMLInputElement).value).toBe("nope@bad");
    expect(screen.getByText("Check nope@bad")).not.toBeNull();
  });

  it("does not submit when the committed draft turns out invalid", () => {
    const onSubmit = vi.fn();
    render(<MultiEmailInviteField onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox", WORK_EMAILS);

    fireEvent.change(input, { target: { value: "nope@bad" } });
    fireEvent.click(screen.getByRole("button", { name: SEND_BUTTON }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Check nope@bad")).not.toBeNull();
  });

  it("submits chips plus a valid draft committed on send", () => {
    const onSubmit = vi.fn();
    render(<MultiEmailInviteField onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox", WORK_EMAILS);

    fireEvent.change(input, { target: { value: "a@x.com " } });
    fireEvent.change(input, { target: { value: "b@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: SEND_BUTTON }));

    expect(onSubmit).toHaveBeenCalledWith(["a@x.com", "b@x.com"]);
  });

  it("disables send and submits nothing with no recipients", () => {
    const onSubmit = vi.fn();
    render(<MultiEmailInviteField onSubmit={onSubmit} />);
    const button = screen.getByRole("button", { name: SEND_BUTTON });

    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
