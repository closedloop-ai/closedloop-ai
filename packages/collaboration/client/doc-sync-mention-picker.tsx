"use client";

import { LiveblocksSchemaName } from "@repo/document-schema/liveblocks";
import { type Editor, Extension, type Range } from "@tiptap/core";
import { type EditorState, PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, {
  exitSuggestion,
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { useLayoutEffect, useState } from "react";
import { mentionQueryMatchesUser } from "../shared/mention-matching";
import type { DocSyncConfig, DocSyncMentionCandidate } from "./doc-sync-config";

/**
 * The body `@`-mention picker on doc-sync (PLN-2189 T-2.7). Typing `@` offers
 * the active org members whose name or email matches, by the comment
 * composer's rule and cap, in the host's shared suggestion list; choosing one
 * inserts the shared `liveblocksMention` node with that user's id, then a
 * space. No group mentions are offered, as on the Liveblocks picker.
 *
 * `getConfig` is read on every keystroke, so the extension is built once and
 * still sees the current member list.
 */
export function createDocSyncMentionPicker(
  getConfig: () => DocSyncConfig | null | undefined
): Extension {
  return Extension.create({
    name: "docSyncMentionPicker",
    addProseMirrorPlugins() {
      return [
        Suggestion<DocSyncMentionCandidate, DocSyncMentionCandidate>({
          editor: this.editor,
          char: "@",
          pluginKey: DOC_SYNC_MENTION_PICKER_KEY,
          allow: ({ state, range }) => mentionFitsAt(state, range),
          items: ({ query }) => matchCandidates(getConfig(), query),
          command: ({ editor, range, props }) =>
            insertMention(editor, range, props.id),
          render: () => createPickerRenderer(getConfig),
        }),
      ];
    },
  });
}

const DOC_SYNC_MENTION_PICKER_KEY = new PluginKey("docSyncMentionPicker");

/**
 * Only where the block can hold a mention node, so `@` in a code block types
 * through. The Liveblocks `MentionExtension` applies the same check.
 */
function mentionFitsAt(state: EditorState, range: Range) {
  const mention = state.schema.nodes[LiveblocksSchemaName.Mention];
  return Boolean(
    mention &&
      state.doc.resolve(range.from).parent.type.contentMatch.matchType(mention)
  );
}

function matchCandidates(
  config: DocSyncConfig | null | undefined,
  query: string
): DocSyncMentionCandidate[] {
  if (!config) {
    return [];
  }
  return config.mentionCandidates
    .filter((user) => user.active && mentionQueryMatchesUser(user, query))
    .slice(0, config.maxMentionSuggestions);
}

function insertMention(editor: Editor, range: Range, userId: string) {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      {
        type: LiveblocksSchemaName.Mention,
        attrs: { id: userId, notificationId: null },
      },
      { type: "text", text: " " },
    ])
    .run();
}

type PickerSuggestionProps = SuggestionProps<
  DocSyncMentionCandidate,
  DocSyncMentionCandidate
>;

type PickerPopupProps = {
  items: readonly DocSyncMentionCandidate[];
  activeIndex: number;
  clientRect: PickerSuggestionProps["clientRect"];
  onSelect: (candidate: DocSyncMentionCandidate) => void;
  render: DocSyncConfig["renderMentionSuggestions"] | undefined;
};

/**
 * Suggestion lifecycle for one picker: the popup lives in the editor's React
 * tree through `ReactRenderer`, and the highlighted row is kept here because
 * the keys arrive at the editor, which keeps focus.
 *
 * A pointerdown outside the editor and the popup closes the picker, as
 * Suggestion's own mount does; this renderer positions its list itself, so it
 * installs that handler here. The list renders inside the renderer's element,
 * so a row's pointerdown counts as inside and the mousedown that picks it
 * still runs.
 */
function createPickerRenderer(
  getConfig: () => DocSyncConfig | null | undefined
) {
  let renderer: ReactRenderer<unknown, PickerPopupProps> | null = null;
  let current: PickerSuggestionProps | null = null;
  let activeIndex = 0;
  let removeOutsideListener: (() => void) | null = null;

  const popupProps = (props: PickerSuggestionProps): PickerPopupProps => ({
    items: props.items,
    activeIndex,
    clientRect: props.clientRect,
    onSelect: props.command,
    render: getConfig()?.renderMentionSuggestions,
  });

  const moveActive = (step: number) => {
    const count = current?.items.length ?? 0;
    if (!(current && count > 0)) {
      return false;
    }
    activeIndex = (activeIndex + step + count) % count;
    renderer?.updateProps(popupProps(current));
    return true;
  };

  return {
    onStart: (props: PickerSuggestionProps) => {
      current = props;
      activeIndex = 0;
      renderer = new ReactRenderer(DocSyncMentionPickerPopup, {
        editor: props.editor,
        props: popupProps(props),
      });
      // `destroy()` detaches it again.
      globalThis.document.body.append(renderer.element);
      removeOutsideListener = dismissOnOutsidePointer(
        props.editor,
        renderer.element
      );
    },
    onUpdate: (props: PickerSuggestionProps) => {
      // Each fetch first reports itself with no items; the list holds its
      // rows and highlight until the fetched ones arrive.
      if (props.loading) {
        return;
      }
      // Suggestion also updates when the range moves under a peer's edit; the
      // highlight survives that and resets only when the query changes.
      if (props.query !== current?.query || activeIndex >= props.items.length) {
        activeIndex = 0;
      }
      current = props;
      renderer?.updateProps(popupProps(props));
    },
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      if (event.key === "ArrowDown") {
        return moveActive(1);
      }
      if (event.key === "ArrowUp") {
        return moveActive(-1);
      }
      if (event.key === "Enter") {
        const chosen = current?.items[activeIndex];
        if (!(current && chosen)) {
          return false;
        }
        current.command(chosen);
        return true;
      }
      return false;
    },
    onExit: () => {
      removeOutsideListener?.();
      removeOutsideListener = null;
      renderer?.destroy();
      renderer = null;
      current = null;
    },
  };
}

function dismissOnOutsidePointer(editor: Editor, popup: HTMLElement) {
  const onPointerDown = (event: PointerEvent) => {
    const { target } = event;
    if (
      !(target instanceof Node) ||
      popup.contains(target) ||
      editor.view.dom.contains(target)
    ) {
      return;
    }
    exitSuggestion(editor.view, DOC_SYNC_MENTION_PICKER_KEY);
  };
  globalThis.document.addEventListener("pointerdown", onPointerDown, true);
  return () =>
    globalThis.document.removeEventListener("pointerdown", onPointerDown, true);
}

/**
 * Anchors the host's list to the `@` query. The rect is re-read on scroll and
 * resize so the fixed menu follows the caret, as the composer's follows its
 * textarea. The list renders into this popup's own element, inside the
 * renderer's, which is what the outside-pointer check treats as the popup.
 */
function DocSyncMentionPickerPopup({
  items,
  activeIndex,
  clientRect,
  onSelect,
  render,
}: Readonly<PickerPopupProps>) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const measure = () => setAnchorRect(clientRect?.() ?? null);
    measure();
    globalThis.addEventListener("scroll", measure, true);
    globalThis.addEventListener("resize", measure);
    return () => {
      globalThis.removeEventListener("scroll", measure, true);
      globalThis.removeEventListener("resize", measure);
    };
  }, [clientRect]);

  return (
    <div ref={setContainer}>
      {render && container && anchorRect && items.length > 0
        ? render({
            suggestions: items,
            activeIndex,
            anchorRect,
            onSelect,
            container,
          })
        : null}
    </div>
  );
}
