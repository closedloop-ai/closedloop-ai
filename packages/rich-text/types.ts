import type { ResolvedInlineImage as ApiResolvedInlineImage } from "@repo/api/src/types/attachment";
import type { AnyExtension, Editor } from "@tiptap/react";

export type TiptapEditor = Editor & {
  /**
   * Reset the editor content from a markdown string.
   * Temporarily makes the editor editable if it's read-only,
   * so the command succeeds even in view mode.
   */
  resetContent: (markdown: string) => void;
  /**
   * Insert an inline image through the editor-owned placeholder/upload flow.
   * The editor adds a durable node only after the app upload callback returns
   * an `attachment://...` reference.
   */
  insertInlineImageFile?: (file: File) => Promise<void>;
};

export type InlineImageUploadResult = {
  src: string;
  alt?: string;
};

export type ResolvedInlineImage = ApiResolvedInlineImage;

export type InlineImageResolver = (
  attachmentIds: string[]
) => Promise<{ images: ResolvedInlineImage[] }>;

export type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onEditorReady?: (editor: TiptapEditor | null) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  liveblocksExtension?: AnyExtension;
  /**
   * Whether the Liveblocks editor has finished syncing and is ready.
   * Only used when liveblocksExtension is provided.
   * When true, indicates that Yjs sync is complete.
   */
  liveblocksIsReady?: boolean;
  /**
   * When true, an empty synced collaboration document is never seeded from
   * `value`, because the service seeds it (ISS-12508). Defaults to false.
   */
  skipEmptyRoomSeed?: boolean;
  /**
   * Where scrolling is handled for the editor content.
   * "inner" keeps scroll inside the editor; "outer" lets a parent container scroll.
   */
  scrollMode?: "inner" | "outer";
  /**
   * When true, the formatting toolbar is not rendered inline.
   * Use with the exported TiptapToolbar to render the toolbar elsewhere.
   */
  externalToolbar?: boolean;
  /**
   * Controls toolbar visibility.
   * "always" (default) shows the toolbar whenever the editor is not read-only.
   * "focus" hides the toolbar until the editor receives focus.
   */
  toolbarMode?: "always" | "focus";
  /**
   * Enables the document inline-image AUTHORING controls — the toolbar button,
   * and the paste and drop upload paths. It no longer gates URL resolution:
   * since ISS-8387 a ref is resolved exactly when `resolveInlineImages` is
   * supplied, so a host that wants reading closed withholds that prop rather
   * than relying on this one. The image schema stays registered even when this
   * is false so collaborators do not drop refs.
   */
  inlineImagesEnabled?: boolean;
  /**
   * App-owned upload callback. Rich text stays document-agnostic and only
   * inserts the returned durable `attachment://...` reference.
   */
  uploadInlineImage?: (file: File) => Promise<InlineImageUploadResult>;
  /**
   * App-owned resolver for turning durable attachment refs into display URLs.
   *
   * MUST be referentially stable across the host's renders. Since ISS-9795 the
   * resolver reaches each image's node view through React context, and the node
   * view keys its fetch on this callback's identity, so a host that rebuilds it
   * every render clears and re-fetches every image in the document every render
   * (ISS-9805). Memoize it — `useCallback`, or a `useMemo`'d options object as
   * `useInlineImageEditorOptions` does. The identity-keyed behaviour this rests
   * on is pinned by `inline-image-node-view.test.tsx`.
   */
  resolveInlineImages?: InlineImageResolver;
  /**
   * Validates the exact file that will be uploaded. Return null when accepted,
   * otherwise a user-facing rejection reason.
   */
  validateInlineImageFile?: (file: File) => string | null;
  onInlineImageUploadError?: (message: string) => void;
};
