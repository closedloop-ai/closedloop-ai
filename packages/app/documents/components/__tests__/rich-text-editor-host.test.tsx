import type { RichTextEditorProps } from "@repo/rich-text";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseFeatureFlagEnabled = vi.fn();
const mockUploadMutateAsync = vi.fn();
const mockUploadReset = vi.fn();
const mockResolveMutateAsync = vi.fn();
const mockRichTextEditor = vi.fn((_props: RichTextEditorProps) => null);
const mockToastError = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flagKey: string) =>
    mockUseFeatureFlagEnabled(flagKey),
}));

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
    mockUseFeatureFlagEnabled.mockImplementation(
      (flagKey: string) => flagKey === "inline-document-images"
    );
  });

  it("passes enabled upload and resolver ports when the feature flag is on", async () => {
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

  it("disables upload and resolve callbacks flag-off while preserving refs", () => {
    mockUseFeatureFlagEnabled.mockImplementation(
      (flagKey: string) => flagKey === "mermaid-enhancements"
    );

    render(
      <RichTextEditorHost
        documentId="doc-1"
        editorUsesLiveblocksContent={false}
        onChange={() => undefined}
        value="![diagram](attachment://00000000-0000-4000-8000-000000000001)"
      />
    );

    const props = latestRichTextProps();
    expect(props.inlineImagesEnabled).toBe(false);
    expect(props.uploadInlineImage).toBeUndefined();
    expect(props.resolveInlineImages).toBeUndefined();
    expect(props.value).toContain(
      "attachment://00000000-0000-4000-8000-000000000001"
    );
    expect(mockUploadMutateAsync).not.toHaveBeenCalled();
    expect(mockResolveMutateAsync).not.toHaveBeenCalled();
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
