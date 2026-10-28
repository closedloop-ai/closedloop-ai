import type { RichTextEditorProps } from "@repo/rich-text";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUploadMutateAsync = vi.fn();
const mockUploadReset = vi.fn();
const mockResolveMutateAsync = vi.fn();
const mockRichTextEditor = vi.fn((_props: RichTextEditorProps) => null);
const mockToastError = vi.fn();

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => mockToastError(message),
  },
}));

vi.mock("@repo/rich-text", () => ({
  RichTextEditor: (props: RichTextEditorProps) => mockRichTextEditor(props),
}));

vi.mock("../../hooks/use-attachments", () => ({
  useResolveInlineImages: () => ({ mutateAsync: mockResolveMutateAsync }),
  useUploadInlineImage: () => ({
    mutateAsync: mockUploadMutateAsync,
    reset: mockUploadReset,
  }),
}));

const mockUseLiveblocksExtension = vi.fn((..._options: unknown[]) => ({}));

vi.mock("@repo/collaboration/client/tiptap", () => ({
  useIsEditorReady: () => false,
  useLiveblocksExtension: (...options: unknown[]) =>
    mockUseLiveblocksExtension(...options),
}));

vi.mock("@liveblocks/react", () => ({
  useRoom: () => ({ id: "org-1:artifact:ISS-1" }),
}));

const docSyncProbe = vi.hoisted(() => ({
  state: undefined as { room: { provider: object } | null } | undefined,
  isSynced: false,
  extension: { name: "docSyncCollaboration" },
}));

vi.mock("@repo/collaboration/client/doc-sync-room", () => ({
  useDocSyncRoom: () => docSyncProbe.state,
  useIsOnDocSync: () => docSyncProbe.state !== undefined,
  useDocSyncIsSynced: () => docSyncProbe.isSynced,
}));

vi.mock("@repo/collaboration/client/doc-sync-extension", () => ({
  useDocSyncExtension: () =>
    docSyncProbe.state?.room ? docSyncProbe.extension : null,
}));

import { RichTextEditorHost } from "../rich-text-editor-host";

function latestRichTextProps() {
  const props = mockRichTextEditor.mock.calls.at(-1)?.[0];
  if (!props) {
    throw new Error("RichTextEditor was not rendered");
  }
  return props;
}

describe("RichTextEditorHost inline image options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docSyncProbe.state = undefined;
  });

  it("passes enabled upload and resolver ports for a saved document", async () => {
    mockResolveMutateAsync.mockResolvedValue({ images: [] });
    mockUploadMutateAsync.mockResolvedValue({
      src: "attachment://00000000-0000-4000-8000-000000000001",
    });

    render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent={false}
        onChange={() => undefined}
        value="![diagram](attachment://00000000-0000-4000-8000-000000000001)"
      />
    );

    const props = latestRichTextProps();
    expect(props.inlineImagesEnabled).toBe(true);
    await expect(
      props.resolveInlineImages?.(["00000000-0000-4000-8000-000000000001"])
    ).resolves.toEqual({ images: [] });
    const file = new File(["image"], "diagram.png", { type: "image/png" });
    await expect(props.uploadInlineImage?.(file)).resolves.toEqual({
      src: "attachment://00000000-0000-4000-8000-000000000001",
    });
    expect(mockResolveMutateAsync).toHaveBeenCalledWith([
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(mockUploadMutateAsync).toHaveBeenCalledWith(file);
  });

  it("resets the upload mutation before showing upload errors", () => {
    render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent={false}
        onChange={() => undefined}
        value=""
      />
    );

    latestRichTextProps().onInlineImageUploadError?.("Image upload failed");

    expect(mockUploadReset).toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Image upload failed");
  });
});

describe("RichTextEditorHost Liveblocks extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docSyncProbe.state = undefined;
  });

  it("asks for the extension with no options", () => {
    // `usePrewarmDocumentRoom` creates the room's Yjs provider with no options
    // before this editor mounts, and the extension adopts that cached provider.
    // Passing options here would be silently ignored for a prewarmed room, so
    // anyone adding one has to revisit the prewarm first.
    render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent
        onChange={() => undefined}
        value=""
      />
    );

    expect(mockUseLiveblocksExtension.mock.calls).toEqual([[]]);
  });

  it("keeps the editor's empty-room seed", () => {
    render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent
        onChange={() => undefined}
        value="# v1"
      />
    );

    expect(latestRichTextProps().skipEmptyRoomSeed).toBeUndefined();
  });
});

describe("RichTextEditorHost on doc-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docSyncProbe.state = { room: { provider: {} } };
    docSyncProbe.isSynced = false;
  });

  it("fills the collaboration slot from the doc-sync room, never Liveblocks", () => {
    render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent
        onChange={() => undefined}
        value=""
      />
    );

    const props = latestRichTextProps();
    expect(props.liveblocksExtension).toBe(docSyncProbe.extension);
    expect(props.liveblocksIsReady).toBe(false);
    expect(mockUseLiveblocksExtension).not.toHaveBeenCalled();
  });

  it("leaves seeding an empty document to the service", () => {
    render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent
        onChange={() => undefined}
        value="# v1"
      />
    );

    expect(latestRichTextProps().skipEmptyRoomSeed).toBe(true);
  });

  it("renders no editor while the room connects", () => {
    docSyncProbe.state = { room: null };
    render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent
        onChange={() => undefined}
        value=""
      />
    );

    expect(mockRichTextEditor).not.toHaveBeenCalled();
    expect(mockUseLiveblocksExtension).not.toHaveBeenCalled();
  });

  it("signals content-ready once per room after the first sync", () => {
    const onContentReady = vi.fn();
    // A fresh callback per render, as an inline arrow in a parent would be, so
    // only the once-per-room guard keeps the signal from repeating.
    const view = render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent
        onChange={() => undefined}
        onContentReady={() => onContentReady()}
        value=""
      />
    );
    expect(onContentReady).not.toHaveBeenCalled();

    docSyncProbe.isSynced = true;
    const rerender = () =>
      view.rerender(
        <RichTextEditorHost
          documentId="doc-1"
          editorUsesLiveblocksContent
          onChange={() => undefined}
          onContentReady={() => onContentReady()}
          value=""
        />
      );
    rerender();
    rerender();
    expect(onContentReady).toHaveBeenCalledTimes(1);

    docSyncProbe.state = { room: { provider: {} } };
    rerender();
    expect(onContentReady).toHaveBeenCalledTimes(2);
  });

  it("keeps a historical version on the plain editor", () => {
    render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent={false}
        onChange={() => undefined}
        value="# v1"
      />
    );

    expect(latestRichTextProps().liveblocksExtension).toBeUndefined();
  });
});
