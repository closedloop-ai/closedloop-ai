"use client";

import { useRoom } from "@liveblocks/react";
import {
  IMAGE_MIME_TYPES,
  isImageMimeType,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
} from "@repo/api/src/types/attachment";
import { useDocSyncExtension } from "@repo/collaboration/client/doc-sync-extension";
import {
  type DocSyncRoomHandle,
  useDocSyncIsSynced,
  useDocSyncRoom,
  useIsOnDocSync,
} from "@repo/collaboration/client/doc-sync-room";
import {
  useIsEditorReady,
  useLiveblocksExtension,
} from "@repo/collaboration/client/tiptap";
import { toast } from "@repo/design-system/components/ui/sonner";
import { cn } from "@repo/design-system/lib/utils";
import type { RichTextEditorProps, TiptapEditor } from "@repo/rich-text";
import { RichTextEditor } from "@repo/rich-text";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useResolveInlineImages,
  useUploadInlineImage,
} from "../hooks/use-attachments";

type RichTextEditorHostProps = {
  documentId?: string;
  /**
   * Current content value (markdown string)
   */
  value: string;
  /**
   * Change handler for content updates
   */
  onChange: (value: string) => void;
  /**
   * When true, the editor uses the Liveblocks Tiptap extension and reads
   * content from the Y.Doc. When false, content comes from `value`. The
   * room itself is provided by the nearest `RoomProvider` ancestor (via
   * `OptionalDocumentRoom`); no room ID is passed through this prop.
   */
  editorUsesLiveblocksContent: boolean;
  /**
   * Callback to get the editor instance (for comments/collaboration features).
   * Called once on every editor mount regardless of the Liveblocks state.
   */
  onEditorReady?: (editor: TiptapEditor | null) => void;
  /**
   * Fired when the editor content is fully loaded and ready to display.
   * For Liveblocks: fires after Y.Doc sync completes.
   * For non-Liveblocks: fires immediately on editor creation.
   */
  onContentReady?: () => void;
  /**
   * Placeholder text when editor is empty
   */
  placeholder?: string;
  /**
   * Whether the editor is read-only
   */
  readOnly?: boolean;
  /**
   * Optional className for custom styling
   */
  className?: string;
  /**
   * Where scrolling is handled for the editor content.
   * "inner" keeps scroll inside the editor; "outer" lets a parent container scroll.
   */
  scrollMode?: "inner" | "outer";
  /**
   * When true, the formatting toolbar is not rendered inline.
   */
  externalToolbar?: boolean;
};

type InlineImageEditorOptions = Pick<
  RichTextEditorProps,
  | "inlineImagesEnabled"
  | "onInlineImageUploadError"
  | "resolveInlineImages"
  | "uploadInlineImage"
  | "validateInlineImageFile"
>;

export function useInlineImageEditorOptions(
  documentId?: string
): InlineImageEditorOptions {
  const uploadInlineImage = useUploadInlineImage(documentId ?? "");
  const resolveInlineImages = useResolveInlineImages(documentId ?? "");
  const canUseInlineImages = !!documentId;

  const validateInlineImageFile = useCallback((file: File) => {
    if (!isImageMimeType(file.type)) {
      return `Inline images must be ${IMAGE_MIME_TYPES.join(", ")}`;
    }
    if (file.size > MAX_ATTACHMENT_FILE_SIZE_BYTES) {
      return "Inline images must be 10 MiB or smaller";
    }
    return null;
  }, []);

  return useMemo(
    () => ({
      inlineImagesEnabled: canUseInlineImages,
      onInlineImageUploadError: (message: string) => {
        uploadInlineImage.reset();
        toast.error(message);
      },
      resolveInlineImages: canUseInlineImages
        ? (attachmentIds: string[]) => {
            // The editor resolver contract awaits per-node results; mutateAsync is
            // intentional so the batch coordinator can fan results back to nodes.
            return resolveInlineImages.mutateAsync(attachmentIds);
          }
        : undefined,
      uploadInlineImage: canUseInlineImages
        ? (file: File) => uploadInlineImage.mutateAsync(file)
        : undefined,
      validateInlineImageFile: canUseInlineImages
        ? validateInlineImageFile
        : undefined,
    }),
    [
      canUseInlineImages,
      resolveInlineImages.mutateAsync,
      uploadInlineImage.mutateAsync,
      uploadInlineImage.reset,
      validateInlineImageFile,
    ]
  );
}

export function RichTextEditorHost({
  documentId,
  value,
  onChange,
  editorUsesLiveblocksContent,
  onEditorReady,
  onContentReady,
  placeholder,
  readOnly,
  className,
  scrollMode = "inner",
  externalToolbar,
}: Readonly<RichTextEditorHostProps>) {
  const shouldUseLiveblocks = editorUsesLiveblocksContent;
  const inlineImageOptions = useInlineImageEditorOptions(documentId);
  const isOnDocSync = useIsOnDocSync();

  // If no roomId, render without Liveblocks
  if (!shouldUseLiveblocks) {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          scrollMode !== "outer" && "overflow-hidden",
          className
        )}
      >
        <RichTextEditor
          externalToolbar={externalToolbar}
          {...inlineImageOptions}
          onChange={onChange}
          onEditorReady={onEditorReady}
          placeholder={placeholder}
          readOnly={readOnly}
          scrollMode={scrollMode}
          value={value}
        />
      </div>
    );
  }

  if (isOnDocSync) {
    return (
      <RichTextEditorHostWithDocSync
        className={className}
        externalToolbar={externalToolbar}
        inlineImageOptions={inlineImageOptions}
        onChange={onChange}
        onContentReady={onContentReady}
        onEditorReady={onEditorReady}
        placeholder={placeholder}
        readOnly={readOnly}
        scrollMode={scrollMode}
        value={value}
      />
    );
  }

  // Has roomId, render with Liveblocks
  return (
    <RichTextEditorHostWithLiveblocks
      className={className}
      externalToolbar={externalToolbar}
      inlineImageOptions={inlineImageOptions}
      onChange={onChange}
      onContentReady={onContentReady}
      onEditorReady={onEditorReady}
      placeholder={placeholder}
      readOnly={readOnly}
      scrollMode={scrollMode}
      value={value}
    />
  );
}

/**
 * Internal component that uses Liveblocks hooks.
 * Only rendered when roomId exists and we're inside RoomProvider.
 */
type RichTextEditorHostWithLiveblocksProps = Omit<
  RichTextEditorHostProps,
  "editorUsesLiveblocksContent" | "enableLiveblocks"
> & {
  inlineImageOptions: InlineImageEditorOptions;
};

function RichTextEditorHostWithLiveblocks({
  value,
  onChange,
  onEditorReady,
  onContentReady,
  placeholder,
  readOnly,
  className,
  scrollMode = "inner",
  externalToolbar,
  inlineImageOptions,
}: Readonly<RichTextEditorHostWithLiveblocksProps>) {
  const liveblocksExtension = useLiveblocksExtension();
  const isEditorReady = useIsEditorReady();
  const room = useRoom();

  // Liveblocks TipTap exposes Y.Doc sync via useIsEditorReady (not a suspending hook), so we
  // notify the parent with onContentReady instead of relying on Suspense for this stage.
  const hasSignalledReady = useRef(false);
  useEffect(() => {
    if (isEditorReady && !hasSignalledReady.current) {
      hasSignalledReady.current = true;
      onContentReady?.();
    }
  }, [isEditorReady, onContentReady]);

  // We need a key we can use with the rich text editor below, to force a remount when
  // the room changes. I am not really sure why this is necessary, but without it, the
  // liveblocks state will not be restored correctly when opening the editor for a second
  // time. The contents will be empty in that case.
  const prevRoomRef = useRef(room);
  const editorKeyRef = useRef(0);
  if (prevRoomRef.current !== room) {
    prevRoomRef.current = room;
    editorKeyRef.current += 1;
    hasSignalledReady.current = false;
  }

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        scrollMode !== "outer" && "overflow-hidden",
        className
      )}
    >
      <RichTextEditor
        externalToolbar={externalToolbar}
        {...inlineImageOptions}
        key={editorKeyRef.current}
        liveblocksExtension={liveblocksExtension}
        liveblocksIsReady={isEditorReady}
        onChange={onChange}
        onEditorReady={onEditorReady}
        placeholder={placeholder}
        readOnly={readOnly}
        scrollMode={scrollMode}
        value={value}
      />
    </div>
  );
}

/**
 * Fills the editor's collaboration slot from the nearest `DocSyncRoom`
 * (PLN-2189 T-3.3). Renders nothing until the room exists; a room that never
 * syncs is covered by the scaffold's editor-ready timeout.
 */
function RichTextEditorHostWithDocSync({
  className,
  scrollMode = "inner",
  ...editorProps
}: Readonly<RichTextEditorHostWithLiveblocksProps>) {
  const room = useDocSyncRoom()?.room ?? null;
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        scrollMode !== "outer" && "overflow-hidden",
        className
      )}
    >
      {room ? (
        <DocSyncRichTextEditor
          {...editorProps}
          key={docSyncRoomKey(room)}
          scrollMode={scrollMode}
        />
      ) : null}
    </div>
  );
}

/**
 * Mounted once per room, so `onContentReady` fires once per room. It never
 * seeds an empty document from `value`: the service seeds a never-opened
 * document from its latest version when the token is issued, and a failed
 * server seed is not backfilled here (ISS-12508; PLN-2229 AC-010, A-1): the
 * room reports it failed, and the editor never becomes ready (OQ-3).
 */
function DocSyncRichTextEditor({
  value,
  onChange,
  onEditorReady,
  onContentReady,
  placeholder,
  readOnly,
  scrollMode,
  externalToolbar,
  inlineImageOptions,
}: Readonly<Omit<RichTextEditorHostWithLiveblocksProps, "className">>) {
  const extension = useDocSyncExtension();
  const isSynced = useDocSyncIsSynced();

  const hasSignalledReady = useRef(false);
  useEffect(() => {
    if (isSynced && !hasSignalledReady.current) {
      hasSignalledReady.current = true;
      onContentReady?.();
    }
  }, [isSynced, onContentReady]);

  if (!extension) {
    return null;
  }
  return (
    <RichTextEditor
      externalToolbar={externalToolbar}
      {...inlineImageOptions}
      liveblocksExtension={extension}
      liveblocksIsReady={isSynced}
      onChange={onChange}
      onEditorReady={onEditorReady}
      placeholder={placeholder}
      readOnly={readOnly}
      scrollMode={scrollMode}
      skipEmptyRoomSeed
      value={value}
    />
  );
}

/** A stable key per provider, so a new room remounts the editor binding. */
function docSyncRoomKey(room: DocSyncRoomHandle): number {
  let key = docSyncRoomKeys.get(room.provider);
  if (key === undefined) {
    nextDocSyncRoomKey += 1;
    key = nextDocSyncRoomKey;
    docSyncRoomKeys.set(room.provider, key);
  }
  return key;
}

const docSyncRoomKeys = new WeakMap<object, number>();
let nextDocSyncRoomKey = 0;
