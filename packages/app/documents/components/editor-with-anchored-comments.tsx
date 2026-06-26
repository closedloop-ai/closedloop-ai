"use client";

import { OptionalComments } from "@repo/collaboration/client/optional-comments";
import { cn } from "@repo/design-system/lib/utils";
import type { TiptapEditor } from "@repo/rich-text";
import { RichTextToolbar } from "@repo/rich-text/rich-text-toolbar";
import { Suspense, useState } from "react";
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
   * sync. Independent of `liveblocksRoomId`, which controls whether the
   * comment surfaces mount.
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
  scrollMode?: "inner" | "outer";
  showComments?: boolean;
  /**
   * When true, the Feed sidebar is mounted at the editor host level and
   * owns thread display. Suppresses the legacy gutter
   * `AnchoredThreads`/`FloatingThreads` so only one thread surface renders.
   * `FloatingComposer` + `FloatingToolbar` still mount so thread creation
   * is unchanged.
   */
  hasFeedSidebar?: boolean;
  /**
   * The version of the document the user is currently editing. Flows
   * through to `<OptionalComments>` so the `FloatingComposer` stamps
   * `metadata.version` on threads it creates.
   */
  currentVersion?: number;
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
  scrollMode = "outer",
  showComments = true,
  hasFeedSidebar = false,
  currentVersion,
}: Readonly<EditorWithAnchoredCommentsProps>) {
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const roomMounted = !!liveblocksRoomId;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Formatting toolbar — spans full width above the editor+comments split */}
      {!(readOnly || externalToolbar) && (
        <RichTextToolbar
          editor={editor}
          hasLiveblocksExtension={editorUsesLiveblocksContent}
          onPasteMarkdown={(markdown) => editor?.resetContent(markdown)}
          readOnly={readOnly}
        />
      )}

      {/* Scrollable area: editor + anchored comments side by side */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="relative flex min-h-full min-w-0 items-stretch">
          <div className="relative mx-auto flex min-w-0 max-w-[900px] flex-1 flex-col">
            {headerContent}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit wrapper; keyboard users enter edit mode by focusing the editor directly */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
            {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above */}
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                onBodyClick && readOnly && "cursor-text"
              )}
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
                scrollMode={scrollMode}
                value={value}
              />
            </div>
          </div>

          {roomMounted && (
            <Suspense fallback={null}>
              {/* Floating comments on mobile/tablet (< 1280px) */}
              <div className={showComments ? "xl:hidden" : "hidden"}>
                <OptionalComments
                  currentVersion={currentVersion}
                  editor={editor}
                  mode="floating"
                  renderGutterThreads={!hasFeedSidebar}
                  roomId={liveblocksRoomId}
                />
              </div>

              {/* Anchored comments on desktop (>= 1280px) */}
              <div className={showComments ? "hidden xl:block" : "hidden"}>
                <OptionalComments
                  currentVersion={currentVersion}
                  editor={editor}
                  mode="anchored"
                  renderGutterThreads={!hasFeedSidebar}
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
