"use client";

import {
  getAttachmentId,
  type InlineImageAttrs,
  InlineImageNode,
} from "@repo/document-schema/inline-image";
import {
  InlineImageLayout,
  parseInlineImageLayout,
  parseInlineImageWidth,
} from "@repo/document-schema/inline-image-layout";
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  InlineImageLayoutToolbar,
  InlineImageResizeHandle,
} from "./inline-image-layout-controls";
import type { InlineImageResolver, ResolvedInlineImage } from "./types";

/**
 * The live resolver, supplied by the editor host rather than by
 * `InlineImageExtension.configure`.
 *
 * ISS-9795. The editor is constructed once, and the gate that supplies the
 * resolver settles asynchronously, so an editor built inside that window has to
 * pick the resolver up afterwards. Extension options cannot carry it: Tiptap's
 * `extension.options` is a GETTER that rebuilds a fresh object from
 * `addOptions()` on every read, so a value written there after construction
 * lands on a throwaway copy — and even a value that did stick would be invisible
 * to an already-mounted node view, because ProseMirror re-renders one when its
 * node, decorations, or position change and none of those did. Context is the
 * channel that survives both: node views are portalled INTO the React tree
 * under `EditorContent`, so a provider around it both reaches them and
 * re-renders them when the resolver arrives or is withdrawn.
 */
export const InlineImageResolverContext = createContext<
  InlineImageResolver | undefined
>(undefined);

type InlineImageResolveConsumer = {
  resolve: (image: ResolvedInlineImage | null) => void;
  reject: (error: unknown) => void;
};

type PendingInlineImageResolveBatch = {
  attachmentIds: Set<string>;
  consumersById: Map<string, InlineImageResolveConsumer[]>;
};

const pendingInlineImageResolveBatches = new WeakMap<
  InlineImageResolver,
  PendingInlineImageResolveBatch
>();

/**
 * Coalesce same-tick node-view image resolution through the resolver's batch
 * contract so a document with multiple inline images does one API call.
 *
 * @internal
 */
export function resolveInlineImageWithBatch(
  resolveInlineImages: InlineImageResolver,
  attachmentId: string
): Promise<ResolvedInlineImage | null> {
  let batch = pendingInlineImageResolveBatches.get(resolveInlineImages);
  if (!batch) {
    const nextBatch: PendingInlineImageResolveBatch = {
      attachmentIds: new Set(),
      consumersById: new Map(),
    };
    batch = nextBatch;
    pendingInlineImageResolveBatches.set(resolveInlineImages, batch);
    queueMicrotask(() => {
      pendingInlineImageResolveBatches.delete(resolveInlineImages);
      const ids = Array.from(nextBatch.attachmentIds);
      resolveInlineImages(ids)
        .then((result) => {
          const imagesById = new Map(
            result.images.map((image) => [image.attachmentId, image])
          );
          for (const id of ids) {
            const image = imagesById.get(id) ?? null;
            for (const consumer of nextBatch.consumersById.get(id) ?? []) {
              consumer.resolve(image);
            }
          }
        })
        .catch((error: unknown) => {
          for (const consumers of nextBatch.consumersById.values()) {
            for (const consumer of consumers) {
              consumer.reject(error);
            }
          }
        });
    });
  }

  batch.attachmentIds.add(attachmentId);
  return new Promise((resolve, reject) => {
    const consumers = batch.consumersById.get(attachmentId) ?? [];
    consumers.push({ resolve, reject });
    batch.consumersById.set(attachmentId, consumers);
  });
}

const INLINE_IMAGE_LOADING_LABEL = "Loading image…";
const INLINE_IMAGE_UNAVAILABLE_LABEL = "Image unavailable";

function InlineImageComponent({
  node,
  selected,
  editor,
  updateAttributes,
}: Readonly<NodeViewProps>) {
  const resolveInlineImages = useContext(InlineImageResolverContext);
  const attrs = node.attrs as InlineImageAttrs;
  const [resolved, setResolved] = useState<ResolvedInlineImage | null>(null);
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const layout =
    parseInlineImageLayout(attrs.layout) ?? InlineImageLayout.Inline;
  const width = previewWidth ?? parseInlineImageWidth(attrs.width);
  const isEditable = useEditableEditor(editor);
  const showControls = Boolean(resolved && selected && isEditable);
  const attachmentId = getAttachmentId(attrs.src);
  const canResolve = Boolean(attachmentId && resolveInlineImages);

  useEffect(() => {
    setResolved(null);
    setFailed(false);

    if (!(attachmentId && resolveInlineImages)) {
      return;
    }

    let cancelled = false;
    resolveInlineImageWithBatch(resolveInlineImages, attachmentId)
      .then((image) => {
        if (cancelled) {
          return;
        }
        setResolved(image);
        setFailed(image === null);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attachmentId, resolveInlineImages]);

  const isLoading = canResolve && !failed;
  // A resolve still in flight is not an unavailable image. With no resolver
  // supplied — the host's gate for a closed feature — neither state is entered
  // and the static placeholder is all that renders. The alt text rides along
  // because the placeholder is what a screen reader gets instead of the image's
  // accessible name, not in addition to it.
  const label = useMemo(() => {
    const state = isLoading
      ? INLINE_IMAGE_LOADING_LABEL
      : INLINE_IMAGE_UNAVAILABLE_LABEL;
    const described = attrs.alt?.trim();
    return described ? `${state} (${described})` : state;
  }, [attrs.alt, isLoading]);

  return (
    <NodeViewWrapper
      as="span"
      className="inline-image-wrapper"
      data-layout={layout}
    >
      {resolved ? (
        <span className="inline-image-frame">
          {/* biome-ignore lint/performance/noImgElement: @repo/rich-text cannot import next/image; document attachment URLs are short-lived and app-resolved. */}
          {/* biome-ignore lint/correctness/useImageSize: document images are arbitrary attachment dimensions; a stored width sizes it via style */}
          <img
            alt={attrs.alt ?? resolved.filename}
            className="inline-image"
            data-sized={width === null ? undefined : true}
            ref={imageRef}
            src={resolved.url}
            style={width === null ? undefined : { width }}
          />
          {showControls && (
            <>
              <InlineImageLayoutToolbar
                layout={layout}
                onLayoutChange={(next) => updateAttributes({ layout: next })}
              />
              <InlineImageResizeHandle
                imageRef={imageRef}
                layout={layout}
                onCommit={(next) => updateAttributes({ width: next })}
                onPreview={setPreviewWidth}
              />
            </>
          )}
        </span>
      ) : (
        <span
          // No `role="status"`/`aria-live`: one document can hold a dozen images
          // that all settle in a single batch, and that many live regions would
          // announce at once (same reasoning as `count-cell.tsx`).
          aria-busy={isLoading || undefined}
          className="inline-image-placeholder"
          data-failed={failed || undefined}
        >
          {label}
        </span>
      )}
    </NodeViewWrapper>
  );
}

export const InlineImageExtension = InlineImageNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(InlineImageComponent);
  },
});

/**
 * `editor.isEditable`, kept current.
 *
 * Reading the getter during render is not enough: `setEditable` only sets the
 * option and emits `update` (`@tiptap/core` 3.31.3), and `ReactNodeViewRenderer`
 * does not re-render a node view on that event. The host passes `readOnly` to
 * the SAME editor instance when it leaves edit mode, so a selected image kept
 * its toolbar and resize handle, and a click still ran `updateAttributes`
 * against a document the user can no longer edit.
 */
function useEditableEditor(editor: NodeViewProps["editor"] | null): boolean {
  const [isEditable, setIsEditable] = useState(
    () => editor?.isEditable ?? false
  );
  useEffect(() => {
    if (!editor) {
      setIsEditable(false);
      return;
    }
    const sync = () => setIsEditable(editor.isEditable);
    sync();
    // `update` carries `setEditable`; `transaction` covers a view-level
    // editable change that never emits `update`.
    editor.on("update", sync);
    editor.on("transaction", sync);
    return () => {
      editor.off("update", sync);
      editor.off("transaction", sync);
    };
  }, [editor]);
  return isEditable;
}
