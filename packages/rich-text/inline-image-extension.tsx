"use client";

import {
  type JSONContent,
  type MarkdownToken,
  mergeAttributes,
  Node,
} from "@tiptap/core";
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import type { InlineImageResolver, ResolvedInlineImage } from "./types";

const ATTACHMENT_IMAGE_SRC_REGEX = /^attachment:\/\/([0-9a-fA-F-]{36})$/;

type InlineImageOptions = {
  enabled: boolean;
  resolveInlineImages?: InlineImageResolver;
};

type InlineImageAttrs = {
  src?: string | null;
  alt?: string | null;
};

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

function getAttachmentId(src: unknown): string | null {
  if (typeof src !== "string") {
    return null;
  }
  return ATTACHMENT_IMAGE_SRC_REGEX.exec(src)?.[1] ?? null;
}

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

function escapeMarkdownText(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function renderFallbackLabel(_attrs: InlineImageAttrs): string {
  return "Image unavailable";
}

function InlineImageComponent({ node, extension }: Readonly<NodeViewProps>) {
  const { enabled, resolveInlineImages } =
    extension.options as InlineImageOptions;
  const attrs = node.attrs as InlineImageAttrs;
  const attachmentId = getAttachmentId(attrs.src);
  const [resolved, setResolved] = useState<ResolvedInlineImage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setResolved(null);
    setFailed(false);

    if (!(enabled && attachmentId && resolveInlineImages)) {
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
  }, [attachmentId, enabled, resolveInlineImages]);

  const label = useMemo(() => renderFallbackLabel(attrs), [attrs]);

  return (
    <NodeViewWrapper as="span" className="inline-image-wrapper">
      {resolved ? (
        // biome-ignore lint/performance/noImgElement: @repo/rich-text cannot import next/image; document attachment URLs are short-lived and app-resolved.
        // biome-ignore lint/correctness/useImageSize: document images are arbitrary attachment dimensions
        <img
          alt={attrs.alt ?? resolved.filename}
          className="inline-image"
          src={resolved.url}
        />
      ) : (
        <span
          className="inline-image-placeholder"
          data-failed={failed || undefined}
        >
          {label}
        </span>
      )}
    </NodeViewWrapper>
  );
}

declare module "@tiptap/core" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Tiptap command augmentation requires interface merging
  interface Commands<ReturnType> {
    inlineImage: {
      setInlineImage: (attrs: InlineImageAttrs) => ReturnType;
    };
  }
}

export const InlineImageExtension = Node.create<InlineImageOptions>({
  name: "inlineImage",

  group: "inline",

  inline: true,

  atom: true,

  addOptions() {
    return {
      enabled: false,
      resolveInlineImages: undefined,
    };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[src^='attachment://']",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  addCommands() {
    return {
      setInlineImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineImageComponent);
  },

  markdownTokenName: "image",

  parseMarkdown(token: MarkdownToken, helpers) {
    const src = typeof token.href === "string" ? token.href : "";
    const alt = typeof token.text === "string" ? token.text : "";
    if (!getAttachmentId(src)) {
      return helpers.createTextNode(`![${alt}](${src})`);
    }
    return helpers.createNode("inlineImage", {
      alt,
      src,
    });
  },

  renderMarkdown(node: JSONContent) {
    const attrs = (node.attrs ?? {}) as InlineImageAttrs;
    if (!getAttachmentId(attrs.src)) {
      return "";
    }
    const alt = escapeMarkdownText(attrs.alt ?? "");
    return `![${alt}](${attrs.src})`;
  },
});
