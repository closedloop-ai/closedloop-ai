import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type KeyboardEvent, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  MentionCommentComposer,
  MentionCommentTextarea,
  MentionText,
} from "../mention-comment-textarea";

const TEXTAREA_LABEL = "Write a note";
const MENTION_LISTBOX = "Mention someone";

function Harness({
  initialValue = "",
  onKeyDown,
  onValue,
}: {
  initialValue?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onValue?: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <MentionCommentTextarea
      ariaLabel={TEXTAREA_LABEL}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
      onKeyDown={onKeyDown}
      placeholder="Type here"
      value={value}
    />
  );
}

function textarea(): HTMLTextAreaElement {
  const element = screen.getByRole("textbox", { name: TEXTAREA_LABEL });
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("expected a textarea");
  }
  return element;
}

function optionNames() {
  return screen.getAllByRole("option").map((option) => option.textContent);
}

function selectedOptionName() {
  return screen
    .getAllByRole("option")
    .find((option) => option.getAttribute("aria-selected") === "true")
    ?.textContent;
}

describe("MentionCommentTextarea trigger", () => {
  it("opens every person on a bare @ with the first one active", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.queryByRole("listbox", { name: MENTION_LISTBOX })).toBeNull();
    await user.type(textarea(), "@");

    expect(
      screen.getByRole("listbox", { name: MENTION_LISTBOX })
    ).toBeInTheDocument();
    expect(optionNames()).toEqual([
      "AEOttilie Eastwick",
      "PBPascoe Birchall",
      "SCSam Chen",
      "JLJordan Lee",
    ]);
    expect(selectedOptionName()).toBe("AEOttilie Eastwick");
  });

  it("filters people case-insensitively by the text after @", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(textarea(), "hi @PAS");

    expect(optionNames()).toEqual(["PBPascoe Birchall"]);
  });

  it("hides the list when no person matches the query", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(textarea(), "@zz");

    expect(screen.queryByRole("listbox", { name: MENTION_LISTBOX })).toBeNull();
  });

  it("does not treat an @ glued to a word as a mention", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(textarea(), "mail@");

    expect(screen.queryByRole("listbox", { name: MENTION_LISTBOX })).toBeNull();
  });

  it("closes the list once the mention is followed by a new line", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(textarea(), "@a");
    expect(
      screen.getByRole("listbox", { name: MENTION_LISTBOX })
    ).toBeInTheDocument();
    fireEvent.change(textarea(), { target: { value: "@a\n" } });

    expect(screen.queryByRole("listbox", { name: MENTION_LISTBOX })).toBeNull();
  });

  it("reopens the list when the caret is clicked back into a mention", () => {
    render(<Harness initialValue="hi @Sa there" />);
    const input = textarea();

    input.setSelectionRange(6, 6);
    fireEvent.click(input);

    expect(optionNames()).toEqual(["SCSam Chen"]);
  });
});

describe("MentionCommentTextarea keyboard", () => {
  it("moves the active option down and wraps from the last to the first", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    render(<Harness onKeyDown={onKeyDown} />);

    await user.type(textarea(), "@");
    await user.keyboard("{ArrowDown}");
    expect(selectedOptionName()).toBe("PBPascoe Birchall");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(selectedOptionName()).toBe("AEOttilie Eastwick");
    expect(onKeyDown).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "ArrowDown" })
    );
  });

  it("moves the active option up and wraps from the first to the last", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(textarea(), "@");
    await user.keyboard("{ArrowUp}");
    expect(selectedOptionName()).toBe("JLJordan Lee");
    await user.keyboard("{ArrowUp}");
    expect(selectedOptionName()).toBe("SCSam Chen");
  });

  it("inserts the active person on Enter and closes the list", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    const onValue = vi.fn();
    render(<Harness onKeyDown={onKeyDown} onValue={onValue} />);

    await user.type(textarea(), "ping @");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(textarea()).toHaveValue("ping @Pascoe Birchall ");
    expect(onValue).toHaveBeenLastCalledWith("ping @Pascoe Birchall ");
    expect(screen.queryByRole("listbox", { name: MENTION_LISTBOX })).toBeNull();
    expect(onKeyDown).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter" })
    );
  });

  it("inserts the active person on Tab", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(textarea(), "@jor");
    await user.keyboard("{Tab}");

    expect(textarea()).toHaveValue("@Jordan Lee ");
    expect(textarea()).toHaveFocus();
  });

  it("keeps text after the caret and moves the caret past the inserted mention", async () => {
    render(<Harness initialValue="hi @Sa there" />);
    const input = textarea();
    input.setSelectionRange(6, 6);
    fireEvent.click(input);

    fireEvent.keyDown(input, { key: "Enter" });

    // pins current behavior; looks odd because the inserted "@Sam Chen " keeps its trailing space next to the existing one, leaving a double space
    expect(input).toHaveValue("hi @Sam Chen  there");
    await waitFor(() => expect(input.selectionStart).toBe(13));
    expect(input.selectionEnd).toBe(13);
  });

  it("closes the list on Escape without forwarding the key", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    render(<Harness onKeyDown={onKeyDown} />);

    await user.type(textarea(), "@");
    onKeyDown.mockClear();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox", { name: MENTION_LISTBOX })).toBeNull();
    expect(onKeyDown).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Escape" })
    );
  });

  it("forwards navigation keys when no mention is open", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    render(<Harness onKeyDown={onKeyDown} />);

    await user.type(textarea(), "plain");
    onKeyDown.mockClear();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onKeyDown.mock.calls.map(([event]) => event.key)).toEqual([
      "ArrowDown",
      "Enter",
    ]);
  });

  it("forwards keys while a mention query has no matches", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    render(<Harness onKeyDown={onKeyDown} />);

    await user.type(textarea(), "@zz");
    onKeyDown.mockClear();
    await user.keyboard("{ArrowDown}");

    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "ArrowDown" })
    );
  });

  it("inserts the person pressed with the mouse", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(textarea(), "cc @");
    fireEvent.mouseDown(screen.getByRole("option", { name: "SCSam Chen" }));

    expect(textarea()).toHaveValue("cc @Sam Chen ");
    expect(screen.queryByRole("listbox", { name: MENTION_LISTBOX })).toBeNull();
  });
});

describe("MentionText", () => {
  it("splits plain text around known mentions", () => {
    render(
      <p data-testid="body">
        <MentionText text="Ask @Pascoe Birchall and @Nobody today" />
      </p>
    );

    const body = screen.getByTestId("body");
    expect(Array.from(body.children, (child) => child.textContent)).toEqual([
      "Ask ",
      "@Pascoe Birchall",
      " and @Nobody today",
    ]);
    expect(screen.getByText("@Pascoe Birchall")).toHaveClass("text-primary");
    expect(
      screen.getByText("and @Nobody today", { exact: false })
    ).not.toHaveClass("text-primary");
  });

  it("renders a text that is only a mention as one highlighted span", () => {
    render(
      <p data-testid="body">
        <MentionText text="@Sam Chen" />
      </p>
    );

    const body = screen.getByTestId("body");
    expect(body.children).toHaveLength(1);
    expect(body.children[0]).toHaveTextContent("@Sam Chen");
    expect(body.children[0]).toHaveClass("text-primary");
  });

  it("renders text without mentions as a single plain span", () => {
    render(
      <p data-testid="body">
        <MentionText text="no mentions here" />
      </p>
    );

    const body = screen.getByTestId("body");
    expect(body.children).toHaveLength(1);
    expect(body.children[0]).not.toHaveClass("text-primary");
  });

  it("renders nothing for an empty text", () => {
    render(
      <p data-testid="body">
        <MentionText text="" />
      </p>
    );

    expect(screen.getByTestId("body").children).toHaveLength(0);
  });
});

describe("MentionCommentComposer", () => {
  const defaultPlaceholder = "Add a comment and @mention someone…";

  it("submits the trimmed draft and clears it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MentionCommentComposer onSubmit={onSubmit} />);

    const submit = screen.getByRole("button", { name: "Comment" });
    expect(submit).toBeDisabled();
    const input = screen.getByRole("textbox", { name: defaultPlaceholder });
    await user.type(input, "   ");
    expect(submit).toBeDisabled();
    await user.type(input, " looks good ");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith("looks good");
    expect(input).toHaveValue("");
    expect(screen.getAllByRole("button")).toEqual([submit]);
  });

  it("submits with Cmd+Enter and Ctrl+Enter but not a bare Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MentionCommentComposer onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox", { name: defaultPlaceholder });

    await user.type(input, "first");
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenLastCalledWith("first");

    await user.type(input, "second");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenLastCalledWith("second");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("ignores Cmd+Enter on a blank draft", () => {
    const onSubmit = vi.fn();
    render(<MentionCommentComposer onSubmit={onSubmit} />);

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: defaultPlaceholder }),
      { key: "Enter", metaKey: true }
    );

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("resets to the default value and reports cancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <MentionCommentComposer
        cancelLabel="Discard"
        defaultValue="seed"
        onCancel={onCancel}
        onSubmit={vi.fn()}
        placeholder="Reply here"
        submitLabel="Send"
      />
    );
    const input = screen.getByRole("textbox", { name: "Reply here" });
    expect(input).toHaveValue("seed");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();

    await user.type(input, " more");
    expect(input).toHaveValue("seed more");
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("seed");
  });

  it("ignores a modified key other than Enter", () => {
    const onSubmit = vi.fn();
    render(<MentionCommentComposer defaultValue="ready" onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox", { name: defaultPlaceholder });

    fireEvent.keyDown(input, { key: "a", metaKey: true });
    fireEvent.keyDown(input, { ctrlKey: true, key: "b" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("labels the cancel button Cancel by default", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<MentionCommentComposer onCancel={onCancel} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
