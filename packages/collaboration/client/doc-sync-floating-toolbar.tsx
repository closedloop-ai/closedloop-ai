"use client";

import "@liveblocks/react-tiptap/styles.css";
import "@liveblocks/react-ui/styles.css";
import "./comments.css";

import { Toolbar } from "@liveblocks/react-tiptap";
import { LiveblocksUiConfig } from "@liveblocks/react-ui";
import { resolveScrollParent } from "@repo/design-system/lib/scroll-parent";
import type { Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEffect, useMemo, useState } from "react";
import { useIsOnDocSync } from "./doc-sync-room";

/**
 * The selection toolbar on doc-sync (PLN-2189 T-2.9): Tiptap's bubble menu
 * carrying the formatting half of the Liveblocks `FloatingToolbar` through
 * Liveblocks' own toolbar sections, so labels, icons and shortcuts match.
 * There is no Comment control: the composer needs the Liveblocks extension,
 * which a doc-sync editor does not carry (AC-008). Renders nothing outside a
 * `DocSyncRoom`, where `OptionalComments` mounts the Liveblocks one.
 */
export function DocSyncFloatingToolbar({
  editor,
}: Readonly<{ editor: Editor | null }>) {
  const isOnDocSync = useIsOnDocSync();
  if (!(isOnDocSync && editor)) {
    return null;
  }
  return <DocSyncBubbleToolbar editor={editor} />;
}

export const DOC_SYNC_FLOATING_TOOLBAR_KEY = new PluginKey(
  "docSyncFloatingToolbar"
);

/** Matches the Liveblocks `FloatingToolbar`'s default positioning. */
const BUBBLE_MENU_OPTIONS = {
  strategy: "fixed",
  placement: "top",
  offset: 6,
} as const;

/** Liveblocks' `FLOATING_TOOLBAR_COLLISION_PADDING`, which it does not export. */
const COLLISION_PADDING = 10;

/**
 * The menu and its text-style dropdown share one container under `<body>`, so
 * no ancestor overflow clips either. Tiptap keeps the menu open on an editor
 * blur whose focus target is inside the menu's parent, so that parent holds
 * only the menu and the dropdown. With `<body>` as the parent, every focus
 * target on the page would count as inside and blur would never hide the
 * menu, where the Liveblocks toolbar hides (AC-014).
 *
 * The menu repositions on the editor's own scroller, which on the document
 * page is the canvas pane rather than the window, and flips and shifts
 * within it as the Liveblocks toolbar does. Its container is under `<body>`,
 * so without the scroller as the boundary a selection at the start of a line
 * would shift the menu only as far as the viewport, under the sidebar.
 */
function DocSyncBubbleToolbar({ editor }: Readonly<{ editor: Editor }>) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [scrollTarget, setScrollTarget] = useState<HTMLElement | Window>(
    globalThis.window
  );
  useEffect(() => {
    const element = globalThis.document.createElement("div");
    globalThis.document.body.append(element);
    setContainer(element);
    return () => element.remove();
  }, []);
  useEffect(() => {
    setScrollTarget(resolveScrollParent(editor.view.dom) ?? globalThis.window);
  }, [editor]);
  const options = useMemo(() => {
    const overflow = {
      padding: COLLISION_PADDING,
      ...(scrollTarget instanceof HTMLElement && { boundary: scrollTarget }),
    };
    return {
      ...BUBBLE_MENU_OPTIONS,
      scrollTarget,
      flip: { ...overflow, crossAxis: false },
      shift: overflow,
    };
  }, [scrollTarget]);
  if (!container) {
    return null;
  }
  return (
    <BubbleMenu
      appendTo={container}
      editor={editor}
      options={options}
      pluginKey={DOC_SYNC_FLOATING_TOOLBAR_KEY}
    >
      <LiveblocksUiConfig portalContainer={container}>
        <Toolbar
          aria-label="Floating toolbar"
          className="lb-portal lb-elevation lb-tiptap-floating-toolbar lb-collab-floating lb-collab-floating-toolbar"
          editor={editor}
        >
          {DocSyncToolbarSections}
        </Toolbar>
      </LiveblocksUiConfig>
    </BubbleMenu>
  );
}

/**
 * Passed as the toolbar's component slot, not as elements: the toolbar
 * re-renders a slot component on every editor transaction, while element
 * children keep their identity and would show the previous selection's
 * style and marks.
 *
 * Opted out of the React Compiler: it caches this component's prop-less
 * elements, which brings the same stale identity back, so the sections
 * never recompute their pressed and disabled state.
 */
function DocSyncToolbarSections() {
  "use no memo";
  return (
    <>
      <Toolbar.BlockSelector />
      <Toolbar.SectionInline />
    </>
  );
}
