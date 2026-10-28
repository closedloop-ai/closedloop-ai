import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MentionComposer } from "../mention-composer";

const mockUseOrganizationUsers = vi.fn();

const SUGGESTIONS_TEST_ID = "mention-suggestions";

const ADA = {
  id: "u-ada",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  avatarUrl: null,
  active: true,
};
const GRACE = {
  id: "u-grace",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  avatarUrl: null,
  active: true,
};

function textarea(): HTMLTextAreaElement {
  const el = screen.getByRole("textbox");
  if (!(el instanceof HTMLTextAreaElement)) {
    throw new Error("composer textarea not rendered");
  }
  return el;
}

const resizeObserverCallbacks: Array<() => void> = [];

class RecordingResizeObserver {
  constructor(callback: () => void) {
    resizeObserverCallbacks.push(callback);
  }
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 10,
    right: 310,
    width: 300,
    height: bottom - top,
    x: 10,
    y: top,
    toJSON: () => ({}),
  };
}

describe("MentionComposer branches", () => {
  beforeEach(() => {
    mockUseOrganizationUsers.mockReturnValue({ data: [ADA, GRACE] });
  });

  afterEach(() => {
    resizeObserverCallbacks.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("focuses the seeded draft with the caret at its end when autoFocus is set", () => {
    render(
      <MentionComposer
        autoFocus
        defaultValue="seeded draft"
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    expect(textarea()).toHaveFocus();
    expect(textarea().selectionStart).toBe("seeded draft".length);
    expect(textarea().selectionEnd).toBe("seeded draft".length);
  });

  it("does not take focus without autoFocus", () => {
    render(
      <MentionComposer
        defaultValue="seeded draft"
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    expect(textarea()).not.toHaveFocus();
  });

  it("space-prefixes the '@' the toolbar button inserts after a word", async () => {
    const user = userEvent.setup();
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.type(textarea(), "hello");
    await user.click(screen.getByRole("button", { name: "Mention" }));

    expect(textarea().value).toBe("hello @");
    expect(await screen.findByTestId(SUGGESTIONS_TEST_ID)).toBeInTheDocument();
  });

  it("does not add a second space when the caret already follows whitespace", async () => {
    const user = userEvent.setup();
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.type(textarea(), "hello ");
    await user.click(screen.getByRole("button", { name: "Mention" }));

    expect(textarea().value).toBe("hello @");
  });

  it("selects the first suggestion on Enter instead of inserting a newline", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );

    await user.type(textarea(), "@");
    expect(await screen.findByTestId(SUGGESTIONS_TEST_ID)).toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(textarea().value).toBe("@Ada Lovelace ");
    // The caret follows the inserted token, ready for the next word.
    expect(textarea().selectionStart).toBe("@Ada Lovelace ".length);
    expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("closes the picker on Escape and leaves the typed text alone", async () => {
    const user = userEvent.setup();
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.type(textarea(), "ping @gr");
    expect(await screen.findByTestId(SUGGESTIONS_TEST_ID)).toHaveTextContent(
      "Grace Hopper"
    );
    // A bare keydown, so the keyup re-sync does not reopen the picker.
    await user.keyboard("{Escape>}");

    expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull();
    expect(textarea().value).toBe("ping @gr");
  });

  it("submits with Ctrl+Enter and clears the draft when onSubmit returns nothing", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );

    await user.type(textarea(), "  shortcut note  ");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(onSubmit).toHaveBeenCalledWith({
      body: "shortcut note",
      mentions: [],
    });
    expect(textarea().value).toBe("");
  });

  it("ignores a keyboard submit of a whitespace-only draft", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );

    await user.type(textarea(), "   ");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  });

  it("ignores a keyboard submit while disabled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );

    await user.type(textarea(), "draft");
    rerender(
      <MentionComposer
        disabled
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "Enter",
      })
    );

    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea()).toBeDisabled();
  });

  it("names the textarea through labelledBy instead of the placeholder", () => {
    render(
      <>
        <span id="composer-label">Add a comment</span>
        <MentionComposer
          labelledBy="composer-label"
          members={mockUseOrganizationUsers().data}
          onSubmit={vi.fn()}
          placeholder="Write something"
        />
      </>
    );

    const field = screen.getByRole("textbox", { name: "Add a comment" });
    expect(field).not.toHaveAttribute("aria-label");
    expect(field).toHaveAttribute("aria-labelledby", "composer-label");
  });

  it("uses the placeholder as the accessible name when no label is wired", () => {
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
        placeholder="Write something"
      />
    );

    expect(
      screen.getByRole("textbox", { name: "Write something" })
    ).toBeInTheDocument();
  });

  it("renders Cancel only when an onCancel handler is given, with custom labels", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { rerender } = render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    rerender(
      <MentionComposer
        cancelLabel="Discard"
        isPending={false}
        members={mockUseOrganizationUsers().data}
        onCancel={onCancel}
        onSubmit={vi.fn()}
        submitLabel="Reply"
      />
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Reply" })).toBeDisabled();
  });

  it("re-submits a seeded mention whose token is still in the edited body", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MentionComposer
        defaultValue="@Ada Lovelace please review"
        initialMentions={[ADA]}
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenCalledWith({
      body: "@Ada Lovelace please review",
      mentions: ["u-ada"],
    });
  });

  it("resolves a mention at a later token when an earlier occurrence runs into a longer word", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MentionComposer
        defaultValue="@Ada Lovelaces and @Ada Lovelace"
        initialMentions={[ADA]}
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenCalledWith({
      body: "@Ada Lovelaces and @Ada Lovelace",
      mentions: ["u-ada"],
    });
  });

  it("shows no picker while the member list has not loaded", async () => {
    const user = userEvent.setup();
    mockUseOrganizationUsers.mockReturnValue({ data: undefined });
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.type(textarea(), "@");

    expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull();
  });

  it("still opens the picker where ResizeObserver is unavailable", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("ResizeObserver", undefined);
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));

    expect(await screen.findByTestId(SUGGESTIONS_TEST_ID)).toHaveTextContent(
      "Ada Lovelace"
    );
  });

  it("opens the menu above the textarea when there is more room above than below", async () => {
    const user = userEvent.setup();
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "getBoundingClientRect"
    ).mockReturnValue(rect(600, globalThis.innerHeight - 68));
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));
    const menu = await screen.findByTestId(SUGGESTIONS_TEST_ID);

    expect(menu.style.bottom).toBe(`${globalThis.innerHeight - 600 + 4}px`);
    expect(menu.style.top).toBe("");
    expect(menu.style.maxHeight).toBe("224px");
    expect(menu.style.left).toBe("10px");
    expect(menu.style.width).toBe("300px");
  });

  it("stays below a cramped textarea when there is even less room above, capping its height", async () => {
    const user = userEvent.setup();
    const bottom = globalThis.innerHeight - 68;
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "getBoundingClientRect"
    ).mockReturnValue(rect(50, bottom));
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));
    const menu = await screen.findByTestId(SUGGESTIONS_TEST_ID);

    expect(menu.style.top).toBe(`${bottom + 4}px`);
    expect(menu.style.bottom).toBe("");
    expect(menu.style.maxHeight).toBe("64px");
  });

  it("opens below with the full height when there is ample room below", async () => {
    const user = userEvent.setup();
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "getBoundingClientRect"
    ).mockReturnValue(rect(20, 100));
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));
    const menu = await screen.findByTestId(SUGGESTIONS_TEST_ID);

    await waitFor(() => expect(menu.style.top).toBe("104px"));
    expect(menu.style.maxHeight).toBe("224px");
  });
  it("names itself with the default placeholder and button labels", () => {
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(
      screen.getByRole("textbox", { name: "Add a comment..." })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("inserts the toolbar '@' at the caret rather than at the end of the draft", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <MentionComposer
        defaultValue="hello world"
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    const field = textarea();
    field.focus();
    field.setSelectionRange(5, 5);
    await user.click(screen.getByRole("button", { name: "Mention" }));

    expect(field.value).toBe("hello @ world");
  });

  it("inserts a bare '@' into an empty draft", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));

    expect(textarea().value).toBe("@");
  });

  it("space-prefixes the '@' after text that merely contains a space", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <MentionComposer
        defaultValue="hello world"
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    const field = textarea();
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    await user.click(screen.getByRole("button", { name: "Mention" }));

    // Only a trailing space suppresses the inserted one.
    expect(field.value).toBe("hello world @");
  });

  it("reads the query from the caret and replaces only that token mid-draft", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <MentionComposer
        defaultValue="hello world"
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    const field = textarea();
    field.focus();
    field.setSelectionRange(6, 6);
    // `type` would click first and send the caret back to the end.
    await user.keyboard("@gr");

    expect(await screen.findByTestId(SUGGESTIONS_TEST_ID)).toHaveTextContent(
      "Grace Hopper"
    );
    await user.click(screen.getByText("Grace Hopper"));

    expect(field.value).toBe("hello @Grace Hopper world");
  });

  it("reopens the picker when the caret is clicked back into a mention token", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <MentionComposer
        defaultValue="hi @gr"
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull();
    await user.click(textarea());

    expect(await screen.findByTestId(SUGGESTIONS_TEST_ID)).toHaveTextContent(
      "Grace Hopper"
    );
  });

  it("reopens the picker when the caret moves into a token with no edit", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <MentionComposer
        defaultValue="@gr"
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    const field = textarea();
    field.focus();
    field.setSelectionRange(3, 3);
    // Arrow keys change the caret without firing a change event.
    await user.keyboard("{ArrowLeft}");

    expect(await screen.findByTestId(SUGGESTIONS_TEST_ID)).toHaveTextContent(
      "Grace Hopper"
    );
  });

  it("leaves Enter as a newline when the open query matches nobody", async () => {
    const user = userEvent.setup({ delay: null });
    const onSubmit = vi.fn();
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );

    await user.type(textarea(), "@zzz");
    expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull();
    await user.keyboard("{Enter}");

    expect(textarea().value).toBe("@zzz\n");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits on Cmd/Ctrl+Enter only, not on a plain Enter or another chord", async () => {
    const user = userEvent.setup({ delay: null });
    const onSubmit = vi.fn();
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );

    await user.type(textarea(), "note");
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea().value).toBe("note\n");

    await user.keyboard("{Control>}b{/Control}");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ body: "note", mentions: [] });
  });

  it("shows each candidate's initials beside their name and email", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));
    const menu = await screen.findByTestId(SUGGESTIONS_TEST_ID);
    const adaRow = within(menu).getByText("Ada Lovelace").closest("button");
    if (!(adaRow instanceof HTMLElement)) {
      throw new Error("suggestion row not rendered");
    }

    // One initial on every avatar (Nerys, 2026-10-22).
    expect(within(adaRow).getByText("A")).toBeInTheDocument();
    expect(within(adaRow).getByText("ada@example.com")).toBeInTheDocument();
  });

  it("clears the draft when onSubmit returns a plain value rather than a promise", async () => {
    const user = userEvent.setup({ delay: null });
    const onSubmit = vi.fn().mockReturnValue(42);
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={onSubmit}
      />
    );

    await user.type(textarea(), "fire and forget");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe("");
  });

  it("stays below the textarea when the room above and below is equal", async () => {
    const user = userEvent.setup({ delay: null });
    const bottom = globalThis.innerHeight - 100;
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "getBoundingClientRect"
    ).mockReturnValue(rect(100, bottom));
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));
    const menu = await screen.findByTestId(SUGGESTIONS_TEST_ID);

    expect(menu.style.top).toBe(`${bottom + 4}px`);
    expect(menu.style.bottom).toBe("");
    expect(menu.style.maxHeight).toBe("96px");
  });

  it("stays below when the room below is exactly the menu's height", async () => {
    const user = userEvent.setup({ delay: null });
    const bottom = globalThis.innerHeight - 224;
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "getBoundingClientRect"
    ).mockReturnValue(rect(500, bottom));
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));
    const menu = await screen.findByTestId(SUGGESTIONS_TEST_ID);

    expect(menu.style.top).toBe(`${bottom + 4}px`);
    expect(menu.style.bottom).toBe("");
    expect(menu.style.maxHeight).toBe("220px");
  });

  it("re-anchors the open menu on window resize, ancestor scroll, and textarea growth", async () => {
    const user = userEvent.setup({ delay: null });
    vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
    let current = rect(20, 100);
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "getBoundingClientRect"
    ).mockImplementation(() => current);
    render(
      <div data-testid="scroller" style={{ overflow: "auto" }}>
        <MentionComposer
          members={mockUseOrganizationUsers().data}
          onSubmit={vi.fn()}
        />
      </div>
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));
    const menu = await screen.findByTestId(SUGGESTIONS_TEST_ID);
    expect(menu.style.top).toBe("104px");

    current = rect(30, 120);
    fireEvent(globalThis.window, new Event("resize"));
    await waitFor(() => expect(menu.style.top).toBe("124px"));

    // `scroll` does not bubble, so only a capture-phase listener sees an
    // ancestor scrolling.
    current = rect(40, 140);
    fireEvent.scroll(screen.getByTestId("scroller"));
    await waitFor(() => expect(menu.style.top).toBe("144px"));

    current = rect(50, 160);
    act(() => {
      for (const callback of resizeObserverCallbacks) {
        callback();
      }
    });
    await waitFor(() => expect(menu.style.top).toBe("164px"));
  });
});
