"use client";

import { DocSyncFloatingToolbar } from "@repo/collaboration/client/doc-sync-floating-toolbar";
import { OptionalComments } from "@repo/collaboration/client/optional-comments";
import { cn } from "@repo/design-system/lib/utils";
import type { TiptapEditor } from "@repo/rich-text";
import { Suspense, useState } from "react";
import {
  DocumentRichTextToolbar,
  useEditorHasLiveblocksExtension,
} from "./document-rich-text-toolbar";
import { RichTextEditorHost } from "./rich-text-editor-host";

export type EditorWithAnchoredCommentsProps = {
  documentId?: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * When true, the formatting toolbar is not rendered inside this component.
   * The parent is responsible for rendering TiptapToolbar externally.
   */
  externalToolbar?: boolean;
  /**
   * Content rendered above the editor inside the same flex column that
   * shares width with the comments panel, so it stays aligned with the editor.
   */
  headerContent?: React.ReactNode;
  liveblocksRoomId?: string | null;
  /**
   * When true, the editor uses the Liveblocks Tiptap extension for content
   * sync. The comment surfaces need that same extension, so they mount only
   * when this is true AND `liveblocksRoomId` is set — never on the room id
   * alone, which is slug-derived and therefore set on historical versions the
   * host renders with a plain editor (ISS-9849).
   */
  editorUsesLiveblocksContent: boolean;
  onEditorInstance?: (editor: TiptapEditor | null) => void;
  onContentReady?: () => void;
  /**
   * Fired when the user clicks the editor body (not the header). Hosts use
   * this to enter inline edit mode without the header (title, metadata bar)
   * triggering the transition. Receives the mouse event so the host can
   * place the cursor at the click position when entering edit mode.
   */
  onBodyClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  placeholder?: string;
  readOnly?: boolean;
  showComments?: boolean;
  /**
   * The version of the document the user is currently editing. Flows
   * through to `<OptionalComments>` so the `FloatingComposer` stamps
   * `metadata.version` on threads it creates.
   */
  currentVersion?: number;
  /**
   * Hides the body's leading H1 when it just repeats the artifact title the
   * chrome already renders above (ISS-5006). Read view only — the host clears
   * it in edit mode so the author always sees and edits the real document.
   * Presentational: the node stays in the content and is never rewritten.
   */
  hideLeadingTitleHeading?: boolean;
};

export function EditorWithAnchoredComments({
  documentId,
  value,
  onChange,
  externalToolbar = false,
  headerContent,
  liveblocksRoomId,
  editorUsesLiveblocksContent,
  onEditorInstance,
  onContentReady,
  onBodyClick,
  placeholder,
  readOnly,
  showComments = true,
  currentVersion,
  hideLeadingTitleHeading = false,
}: Readonly<EditorWithAnchoredCommentsProps>) {
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  // Every comment surface below reaches into the Liveblocks Tiptap extension's
  // editor storage, and the host only registers that extension when the editor
  // reads its content from the room. `liveblocksRoomId` is slug-derived and so
  // is non-null on EVERY version, including historical ones the host renders
  // with a plain editor — gating on it alone mounted `FloatingComposer` against
  // an editor with no `liveblocksComments` storage, which threw (ISS-9849).
  // Same condition the toolbar uses for its Add Comment control.
  const editorHasLiveblocksExtension = useEditorHasLiveblocksExtension(
    editorUsesLiveblocksContent
  );
  const commentsMounted = !!liveblocksRoomId && editorHasLiveblocksExtension;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Formatting toolbar — spans full width above the editor+comments split */}
      {!(readOnly || externalToolbar) && (
        <DocumentRichTextToolbar
          editor={editor}
          hasLiveblocksExtension={editorUsesLiveblocksContent}
          onPasteMarkdown={(markdown) => editor?.resetContent(markdown)}
          readOnly={readOnly}
        />
      )}

      {/* Editor + anchored comments side by side. Deliberately not a scroll
          container: a page-level ancestor owns scrolling, and a scroller here
          would nest a second scrollbar beside the page's own. */}
      <div className="relative min-h-0 flex-1">
        {/* items-stretch is what keeps the comments column the full height of
            the body beside it; no min-height, since nothing above sets one. */}
        <div className="relative flex min-w-0 items-stretch">
          <div className="relative mx-auto flex min-w-0 max-w-[900px] flex-1 flex-col">
            {headerContent}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit wrapper; keyboard users enter edit mode by focusing the editor directly */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
            {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above */}
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                onBodyClick && readOnly && "cursor-text",
                hideLeadingTitleHeading && HIDE_LEADING_TITLE_HEADING_CLASS
              )}
              data-analytics-action={onBodyClick ? "true" : undefined}
              data-analytics-label="Edit document"
              onClick={onBodyClick}
            >
              <RichTextEditorHost
                documentId={documentId}
                editorUsesLiveblocksContent={editorUsesLiveblocksContent}
                externalToolbar
                onChange={onChange}
                onContentReady={onContentReady}
                onEditorReady={(editor) => {
                  setEditor(editor);
                  onEditorInstance?.(editor);
                }}
                placeholder={placeholder}
                readOnly={readOnly}
                // The page scrolls, not the editor — keeps Tiptap from adding
                // its own scroller inside this one.
                scrollMode="outer"
                value={value}
              />
            </div>
          </div>

          {/* On doc-sync, the selection toolbar without the Comment control
              (PLN-2189 T-2.9); it renders nothing on Liveblocks. */}
          {editorUsesLiveblocksContent && (
            <DocSyncFloatingToolbar editor={editor} />
          )}

          {/* The feed rail owns thread display; this mount carries the
              composer and toolbar that create threads. */}
          {commentsMounted && (
            <Suspense fallback={null}>
              <div className={showComments ? undefined : "hidden"}>
                <OptionalComments
                  currentVersion={currentVersion}
                  editor={editor}
                  roomId={liveblocksRoomId}
                />
              </div>
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Hides only the editor's first top-level heading (ISS-5006). Scoped to
 * `.ProseMirror`'s direct child so it can never reach a heading nested in a
 * blockquote or list, and never a second `#` further down the document. The
 * node stays in the content and the Y.Doc — this is display only, so nothing a
 * save writes back is affected.
 */
const HIDE_LEADING_TITLE_HEADING_CLASS =
  "[&_.ProseMirror>h1:first-child]:hidden";
