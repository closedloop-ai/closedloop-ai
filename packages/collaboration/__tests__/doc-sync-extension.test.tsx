// @vitest-environment jsdom

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { createDocumentExtensions } from "@repo/document-schema/extensions";
import { LiveblocksSchemaName } from "@repo/document-schema/liveblocks";
import { act, render, waitFor } from "@testing-library/react";
import type { Editor, Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc } from "yjs";
import {
  type DocSyncConfig,
  DocSyncConfigContext,
} from "../client/doc-sync-config";
import {
  DOC_SYNC_CARET_CLASS,
  DOC_SYNC_CARET_SELECTION_CLASS,
  useDocSyncExtension,
} from "../client/doc-sync-extension";
import type { DocSyncRoomState } from "../client/doc-sync-room";
import { ANONYMOUS_USER_NAME } from "../shared/presence-utils";

const { mockUseDocSyncRoom } = vi.hoisted(() => ({
  mockUseDocSyncRoom: vi.fn<() => DocSyncRoomState | undefined>(),
}));

vi.mock("../client/doc-sync-room", () => ({
  useDocSyncRoom: mockUseDocSyncRoom,
}));

const USERS: Record<string, { name: string; avatarUrl?: string }> = {
  "user-1": { name: "Ada Lovelace" },
  "user-2": { name: "Grace Hopper", avatarUrl: "https://img.example/g.png" },
};

const CONFIG: DocSyncConfig = {
  fetchToken: () => Promise.reject(new Error("unused")),
  self: { id: "user-1", color: "var(--color-red-500)" },
  resolveUser: (id) => USERS[id],
  mentionCandidates: [],
  maxMentionSuggestions: 6,
  renderMentionSuggestions: () => null,
};

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("useDocSyncExtension", () => {
  it("is null while the room connects", () => {
    mockUseDocSyncRoom.mockReturnValue({ room: null, failed: false });
    let extension: Extension | null | undefined;
    function Probe() {
      extension = useDocSyncExtension();
      return null;
    }
    render(
      <DocSyncConfigContext.Provider value={CONFIG}>
        <Probe />
      </DocSyncConfigContext.Provider>
    );
    expect(extension).toBeNull();
  });

  it("binds Collaboration on the document fragment and adds carets", async () => {
    const editor = await mountEditor();
    const names = editor.extensionManager.extensions.map((ext) => ext.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "collaboration",
        "collaborationCaret",
        LiveblocksSchemaName.CommentMark,
        LiveblocksSchemaName.Mention,
        LiveblocksSchemaName.GroupMention,
      ])
    );
    const collaboration = editor.extensionManager.extensions.find(
      (ext) => ext.name === "collaboration"
    );
    expect(collaboration?.options.field).toBe("default");
  });

  it("renders mentions with the text the Liveblocks node views render", async () => {
    const editor = await mountEditor();
    act(() => {
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              mention(LiveblocksSchemaName.Mention, "user-2"),
              mention(LiveblocksSchemaName.Mention, "user-unknown"),
              mention(LiveblocksSchemaName.GroupMention, "group-1"),
            ],
          },
        ],
      });
    });

    await waitFor(() =>
      expect(mentionTexts()).toEqual([
        "@Grace Hopper",
        "@Anonymous",
        "@group-1",
      ])
    );
  });

  it("renders a user mention with no id as Anonymous without resolving it", async () => {
    const resolveUser = vi.fn((id: string) =>
      id === "" ? { name: "Resolved empty id" } : USERS[id]
    );
    const editor = await mountEditor({ ...CONFIG, resolveUser });
    act(() => {
      editor.commands.setContent(
        paragraphOf(mention(LiveblocksSchemaName.Mention, ""))
      );
    });

    await waitFor(() =>
      expect(mentionTexts()).toEqual([`@${ANONYMOUS_USER_NAME}`])
    );
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it("marks a mention selected only while the node is selected", async () => {
    const editor = await mountEditor();
    act(() => {
      editor.commands.setContent(
        paragraphOf(mention(LiveblocksSchemaName.Mention, "user-2"))
      );
    });
    await waitFor(() => expect(mentionTexts()).toEqual(["@Grace Hopper"]));
    expect(selectedMentions()).toBe(0);

    act(() => {
      editor.commands.setNodeSelection(1);
    });

    await waitFor(() => expect(selectedMentions()).toBe(1));

    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });

    await waitFor(() => expect(selectedMentions()).toBe(0));
  });

  it("keeps comment anchors as Liveblocks thread marks", async () => {
    const editor = await mountEditor();
    act(() => {
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "anchored",
                marks: [
                  {
                    type: LiveblocksSchemaName.CommentMark,
                    attrs: { threadId: "th_1" },
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    const mark = globalThis.document.querySelector(
      ".lb-tiptap-thread-mark[data-lb-thread-id='th_1']"
    );
    expect(mark?.textContent).toBe("anchored");
  });

  it("labels a caret from the org user list, never from the peer", async () => {
    const editor = await mountEditor();
    const caret = editor.extensionManager.extensions.find(
      (ext) => ext.name === "collaborationCaret"
    );
    const render = caret?.options.render as (
      user: Record<string, unknown>
    ) => HTMLElement;

    const known = render({ id: "user-2", name: "Peer-chosen name" });
    expect(known.textContent).toBe("Grace Hopper");
    expect(known.querySelector("img")?.getAttribute("src")).toBe(
      "https://img.example/g.png"
    );
    expect(known.style.getPropertyValue("--doc-sync-peer-color")).not.toBe("");
    // doc-sync-carets.css styles only this class; Liveblocks carets share the
    // `collaboration-carets__*` names and keep their own look.
    expect([...known.classList]).toEqual([
      "collaboration-carets__caret",
      DOC_SYNC_CARET_CLASS,
    ]);

    const unknown = render({ id: "user-x", name: "Peer-chosen name" });
    expect(unknown.textContent).toBe("Anonymous");
    expect(unknown.querySelector("img")).toBeNull();
  });

  it.each([
    ["no id", {}],
    ["an empty id", { id: "" }],
    ["a non-string id", { id: 7 }],
  ])(
    "renders an uncoloured Anonymous caret for a peer with %s",
    async (_label, user) => {
      const resolveUser = vi.fn(CONFIG.resolveUser);
      const editor = await mountEditor({ ...CONFIG, resolveUser });
      const caret = caretOptions(editor);

      const element = caret.render(user);
      expect(element.textContent).toBe(ANONYMOUS_USER_NAME);
      expect(element.querySelector("img")).toBeNull();
      expect(element.style.getPropertyValue("--doc-sync-peer-color")).toBe("");
      expect(resolveUser).not.toHaveBeenCalled();
    }
  );

  it("colours a peer's selection only when the peer has an id", async () => {
    const caret = caretOptions(await mountEditor());
    const caretColor = caret
      .render({ id: "user-2" })
      .style.getPropertyValue("--doc-sync-peer-color");

    expect(caret.selectionRender({ id: "user-2" })).toEqual({
      nodeName: "span",
      class: `collaboration-carets__selection ${DOC_SYNC_CARET_SELECTION_CLASS}`,
      style: `--doc-sync-peer-color: ${caretColor}`,
    });
    expect(caret.selectionRender({ id: "" })).toEqual({
      nodeName: "span",
      class: `collaboration-carets__selection ${DOC_SYNC_CARET_SELECTION_CLASS}`,
    });
  });

  it("advertises the signed-in user on the caret, and nobody when signed out", async () => {
    // CollaborationCaret merges its own defaults into `user`.
    expect(caretOptions(await mountEditor()).user).toEqual(
      expect.objectContaining({ id: "user-1", color: "var(--color-red-500)" })
    );
    const signedOut = caretOptions(
      await mountEditor({ ...CONFIG, self: null })
    ).user;
    expect(signedOut).not.toHaveProperty("id");
    expect(signedOut.color).not.toBe("var(--color-red-500)");
  });
});

type CaretOptions = {
  user: Record<string, unknown>;
  render: (user: Record<string, unknown>) => HTMLElement;
  selectionRender: (user: Record<string, unknown>) => Record<string, unknown>;
};

function caretOptions(editor: Editor): CaretOptions {
  const caret = editor.extensionManager.extensions.find(
    (ext) => ext.name === "collaborationCaret"
  );
  if (!caret) {
    throw new Error("collaborationCaret is not registered");
  }
  return caret.options;
}

async function mountEditor(config: DocSyncConfig = CONFIG) {
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
    return <EditorContent editor={editor} />;
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

function mention(type: string, id: string) {
  return { type, attrs: { id } };
}

function mentionTexts() {
  return [...globalThis.document.querySelectorAll(".lb-tiptap-mention")].map(
    (node) => node.textContent
  );
}

function paragraphOf(node: Record<string, unknown>) {
  return { type: "doc", content: [{ type: "paragraph", content: [node] }] };
}

function selectedMentions() {
  return globalThis.document.querySelectorAll(".lb-mention-selected").length;
}
