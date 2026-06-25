"use client";

import { useRoom } from "@liveblocks/react";
import {
  IMAGE_MIME_TYPES,
  isImageMimeType,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
} from "@repo/api/src/types/attachment";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
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

export const INLINE_DOCUMENT_IMAGES_FEATURE_FLAG_KEY = "inline-document-images";
const INLINE_IMAGE_LOG_PREFIX = "[inline-document-images]";

function logInlineImageEditorInfo(
  message: string,
  metadata: Record<string, unknown>
) {
  console.info(`${INLINE_IMAGE_LOG_PREFIX} ${message}`, metadata);
}

function logInlineImageEditorWarn(
  message: string,
  metadata: Record<string, unknown>
) {
  console.warn(`${INLINE_IMAGE_LOG_PREFIX} ${message}`, metadata);
}

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
  const inlineImagesEnabled = useFeatureFlagEnabled(
    INLINE_DOCUMENT_IMAGES_FEATURE_FLAG_KEY
  );
  const uploadInlineImage = useUploadInlineImage(documentId ?? "");
  const resolveInlineImages = useResolveInlineImages(documentId ?? "");
  const canUseInlineImages = inlineImagesEnabled && !!documentId;

  useEffect(() => {
    if (canUseInlineImages) {
      logInlineImageEditorInfo("editor gate enabled", {
        documentId,
        featureFlag: INLINE_DOCUMENT_IMAGES_FEATURE_FLAG_KEY,
        reason: "enabled",
      });
      return;
    }

    logInlineImageEditorInfo("editor gate disabled", {
      documentId: documentId ?? null,
      featureFlag: INLINE_DOCUMENT_IMAGES_FEATURE_FLAG_KEY,
      reason: inlineImagesEnabled ? "missing_document_id" : "feature_disabled",
    });
  }, [canUseInlineImages, documentId, inlineImagesEnabled]);

  const validateInlineImageFile = useCallback(
    (file: File) => {
      const metadata = {
        documentId: documentId ?? null,
        mimeType: file.type,
        purpose: "inline",
        sizeBytes: file.size,
      };
      if (!isImageMimeType(file.type)) {
        logInlineImageEditorWarn("validation rejected", {
          ...metadata,
          reason: "unsupported_mime",
        });
        return `Inline images must be ${IMAGE_MIME_TYPES.join(", ")}`;
      }
      if (file.size > MAX_ATTACHMENT_FILE_SIZE_BYTES) {
        logInlineImageEditorWarn("validation rejected", {
          ...metadata,
          reason: "file_too_large",
        });
        return "Inline images must be 10 MiB or smaller";
      }
      return null;
    },
    [documentId]
  );

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
  const mermaidEnhancementsEnabled = useFeatureFlagEnabled(
    "mermaid-enhancements"
  );
  const inlineImageOptions = useInlineImageEditorOptions(documentId);

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
          mermaidEnhancementsEnabled={mermaidEnhancementsEnabled}
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

  // Has roomId, render with Liveblocks
  return (
    <RichTextEditorHostWithLiveblocks
      className={className}
      externalToolbar={externalToolbar}
      inlineImageOptions={inlineImageOptions}
      mermaidEnhancementsEnabled={mermaidEnhancementsEnabled}
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
  mermaidEnhancementsEnabled: boolean;
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
  mermaidEnhancementsEnabled,
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
        mermaidEnhancementsEnabled={mermaidEnhancementsEnabled}
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
