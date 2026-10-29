// @vitest-environment jsdom

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { createDocumentExtensions } from "@repo/document-schema/extensions";
import { LiveblocksSchemaName } from "@repo/document-schema/liveblocks";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc } from "yjs";
import {
  type DocSyncConfig,
  DocSyncConfigContext,
  type DocSyncMentionCandidate,
} from "../client/doc-sync-config";
import { useDocSyncExtension } from "../client/doc-sync-extension";
import type { DocSyncRoomState } from "../client/doc-sync-room";
import { installJsdomLayoutStubs } from "./support/jsdom-layout-stubs";

/** PLN-2189 T-2.7 / AC-007: typing `@` in the doc-sync body. */
const { mockUseDocSyncRoom } = vi.hoisted(() => ({
  mockUseDocSyncRoom: vi.fn<() => DocSyncRoomState | undefined>(),
}));

vi.mock("../client/doc-sync-room", () => ({
  useDocSyncRoom: mockUseDocSyncRoom,
}));

const SUGGESTIONS_TEST_ID = "picker-suggestions";

/** An element on the page outside the editor and the picker. */
const OUTSIDE_TEST_ID = "outside";

const CANDIDATES: DocSyncMentionCandidate[] = [
  { ...member("user-gone", "Gretchen", "Gone"), active: false },
  member("user-ada", "Ada", "Lovelace"),
  member("user-grace", "Grace", "Hopper"),
  member("user-gray", "Gray", "Matter"),
  member("user-greta", "Greta", "Garbo"),
];

const cleanups: (() => void)[] = [];

installJsdomLayoutStubs();

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("doc-sync body mention picker", () => {
  it("opens on '@' with the active members matching the query, capped", async () => {
    const editor = await mountEditor({ maxMentionSuggestions: 2 });

    await typeText(editor, "hi @gr");

    expect(await suggestionNames()).toEqual(["Grace Hopper", "Gray Matter"]);

    await typeText(editor, "ac");

    expect(await suggestionNames()).toEqual(["Grace Hopper"]);
  });

  it("moves the highlight with the arrow keys and inserts the chosen member on Enter", async () => {
    const editor = await mountEditor();
    await typeText(editor, "@gra");
    await suggestionNames();
    expect(highlighted()).toBe("Grace Hopper");

    await keyDown(editor, "ArrowDown");
    expect(highlighted()).toBe("Gray Matter");
    await keyDown(editor, "ArrowDown");
    expect(highlighted()).toBe("Grace Hopper");
    await keyDown(editor, "ArrowUp");
    expect(highlighted()).toBe("Gray Matter");

    await keyDown(editor, "Enter");
    await nextAnimationFrame();

    await waitFor(() =>
      expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull()
    );
    expect(paragraphContent(editor)).toEqual([
      {
        type: LiveblocksSchemaName.Mention,
        attrs: { id: "user-gray", notificationId: null },
      },
      { type: "text", text: " " },
    ]);
  });

  it("inserts the member chosen with the pointer", async () => {
    const editor = await mountEditor();
    await typeText(editor, "ping @ada");
    await suggestionNames();

    fireEvent.mouseDown(screen.getByRole("option", { name: "Ada Lovelace" }));

    expect(paragraphContent(editor)).toEqual([
      { type: "text", text: "ping " },
      {
        type: LiveblocksSchemaName.Mention,
        attrs: { id: "user-ada", notificationId: null },
      },
      { type: "text", text: " " },
    ]);
  });

  it("closes on Escape and leaves the typed text", async () => {
    const editor = await mountEditor();
    await typeText(editor, "@gr");
    await suggestionNames();

    await keyDown(editor, "Escape");

    await waitFor(() =>
      expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull()
    );
    expect(paragraphContent(editor)).toEqual([{ type: "text", text: "@gr" }]);
  });

  it("does not open mid-word, so an email address types through", async () => {
    const editor = await mountEditor();

    await typeText(editor, "ada@gr");

    expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull();
  });

  it("does not open in a code block, which cannot hold a mention", async () => {
    const editor = await mountEditor();
    act(() => {
      editor.commands.setCodeBlock();
    });

    await typeText(editor, "x @gr");
    await keyDown(editor, "Enter");

    expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull();
    expect(editor.getJSON().content?.[0]?.type).toBe("codeBlock");
    expect(editor.getText()).toContain("x @gr");
  });

  it("keeps the highlight when a peer's edit moves the query without changing it", async () => {
    const editor = await mountEditor();
    await typeText(editor, "@gr");
    await suggestionNames();
    await keyDown(editor, "ArrowDown");
    expect(highlighted()).toBe("Gray Matter");

    // A remote insert above the caret: the range shifts, the query does not.
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insertText("peer ", 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(highlighted()).toBe("Gray Matter");

    await keyDown(editor, "Enter");

    expect(paragraphContent(editor)).toEqual([
      { type: "text", text: "peer " },
      {
        type: LiveblocksSchemaName.Mention,
        attrs: { id: "user-gray", notificationId: null },
      },
      { type: "text", text: " " },
    ]);
  });

  it("closes on a pointerdown outside the editor and leaves the typed text", async () => {
    const editor = await mountEditor();
    await typeText(editor, "@gr");
    await suggestionNames();

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId(OUTSIDE_TEST_ID));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByTestId(SUGGESTIONS_TEST_ID)).toBeNull()
    );
    expect(paragraphContent(editor)).toEqual([{ type: "text", text: "@gr" }]);
  });

  it("stays open through a row's pointerdown, so the click still picks it", async () => {
    const editor = await mountEditor();
    await typeText(editor, "@ada");
    await suggestionNames();
    const row = screen.getByRole("option", { name: "Ada Lovelace" });

    await act(async () => {
      fireEvent.pointerDown(row);
      await Promise.resolve();
    });
    fireEvent.mouseDown(row);

    expect(paragraphContent(editor)).toEqual([
      {
        type: LiveblocksSchemaName.Mention,
        attrs: { id: "user-ada", notificationId: null },
      },
      { type: "text", text: " " },
    ]);
  });
});

async function mountEditor(overrides: Partial<DocSyncConfig> = {}) {
  const ydoc = new Doc();
  const websocketProvider = new HocuspocusProviderWebsocket({
    url: "ws://127.0.0.1:1",
    autoConnect: false,
  });
  const provider = new HocuspocusProvider({
    name: "org-1:artifact:PRD-1",
    document: ydoc,
    websocketProvider,
  });
  cleanups.push(() => {
    provider.destroy();
    websocketProvider.destroy();
    ydoc.destroy();
  });
  mockUseDocSyncRoom.mockReturnValue({
    room: { provider, ydoc },
    failed: false,
  });

  const config: DocSyncConfig = {
    fetchToken: () => Promise.reject(new Error("unused")),
    self: { id: "user-self", color: "var(--color-red-500)" },
    resolveUser: (id) => {
      const user = CANDIDATES.find((candidate) => candidate.id === id);
      return user ? { name: displayName(user) } : undefined;
    },
    mentionCandidates: CANDIDATES,
    maxMentionSuggestions: 6,
    renderMentionSuggestions: ({ suggestions, activeIndex, onSelect }) => (
      <div data-testid={SUGGESTIONS_TEST_ID} role="listbox">
        {suggestions.map((candidate, index) => (
          <button
            aria-selected={index === activeIndex}
            key={candidate.id}
            onMouseDown={() => onSelect(candidate)}
            role="option"
            type="button"
          >
            {displayName(candidate)}
          </button>
        ))}
      </div>
    ),
    ...overrides,
  };

  const mounted: { editor: Editor | null } = { editor: null };
  function Harness() {
    const extension = useDocSyncExtension();
    const editor = useEditor({
      immediatelyRender: true,
      extensions: [
        ...createDocumentExtensions({ undoRedo: false }),
        ...(extension ? [extension] : []),
      ],
    });
    mounted.editor = editor;
    return (
      <>
        <EditorContent editor={editor} />
        <div data-testid={OUTSIDE_TEST_ID} />
      </>
    );
  }
  const view = render(
    <DocSyncConfigContext.Provider value={config}>
      <Harness />
    </DocSyncConfigContext.Provider>
  );
  cleanups.unshift(() => view.unmount());
  await waitFor(() => expect(mounted.editor).not.toBeNull());
  const { editor } = mounted;
  if (!editor) {
    throw new Error("editor did not mount");
  }
  return editor;
}

function member(
  id: string,
  firstName: string,
  lastName: string
): DocSyncMentionCandidate {
  return {
    id,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}@example.com`,
    avatarUrl: null,
    active: true,
  };
}

function displayName(user: DocSyncMentionCandidate) {
  return `${user.firstName} ${user.lastName}`;
}

async function typeText(editor: Editor, text: string) {
  await act(async () => {
    editor.commands.insertContent(text);
    await Promise.resolve();
  });
}

/** Async: the editor's React portals commit a microtask after the key. */
async function keyDown(editor: Editor, key: string) {
  await act(async () => {
    fireEvent.keyDown(editor.view.dom, { key });
    await Promise.resolve();
  });
}

async function suggestionNames() {
  const list = await screen.findByTestId(SUGGESTIONS_TEST_ID);
  return [...list.querySelectorAll("[role='option']")].map(
    (option) => option.textContent
  );
}

function highlighted() {
  return screen
    .getByTestId(SUGGESTIONS_TEST_ID)
    .querySelector("[aria-selected='true']")?.textContent;
}

/**
 * Inserting a mention runs tiptap's `focus()`, which scrolls the selection
 * into view on the next animation frame. Awaiting that frame here makes the
 * scroll land inside the test instead of whenever the frame happens to fire.
 */
async function nextAnimationFrame() {
  await act(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  );
}

function paragraphContent(editor: Editor): JSONContent[] | undefined {
  return editor.getJSON().content?.[0]?.content;
}
