import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inline images at the level a reader actually sees. The sibling
 * `rich-text-editor-host.test.tsx` asserts which PORTS the host hands the
 * editor; this one renders the real editor through them and asserts what lands
 * in the DOM, because a wired resolver is only worth anything if the rendered
 * document then shows the image.
 */
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const DOCUMENT_MARKDOWN = `Before\n\n![Diagram](attachment://${ATTACHMENT_ID})\n\nAfter`;
const RESOLVED_URL = "https://example.com/diagram.png";
/** The editor mounts behind a skeleton; this covers that, not a resolve. */
const MOUNT_TIMEOUT_MS = 15_000;
/** Explicit, because the editor mount dominates this suite. */
const TEST_TIMEOUT_MS = 30_000;

const mockResolveMutateAsync = vi.fn();
const mockUploadMutateAsync = vi.fn();
const mockUploadReset = vi.fn();

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("../../hooks/use-attachments", () => ({
  useResolveInlineImages: () => ({ mutateAsync: mockResolveMutateAsync }),
  useUploadInlineImage: () => ({
    mutateAsync: mockUploadMutateAsync,
    reset: mockUploadReset,
  }),
}));

import { RichTextEditorHost } from "../rich-text-editor-host";

function renderDocument() {
  return render(
    <RichTextEditorHost
      documentId="doc-1"
      editorUsesLiveblocksContent={false}
      onChange={() => undefined}
      readOnly={true}
      value={DOCUMENT_MARKDOWN}
    />
  );
}

function placeholderIn(container: HTMLElement) {
  return container.querySelector<HTMLElement>(".inline-image-placeholder");
}

describe("inline document images in the rendered document", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveMutateAsync.mockResolvedValue({
      images: [
        {
          attachmentId: ATTACHMENT_ID,
          expiresAt: "2026-09-01T00:00:00.000Z",
          filename: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 12,
          url: RESOLVED_URL,
        },
      ],
      skipped: [],
    });
  });

  it(
    "renders the resolved image",
    async () => {
      const { container } = renderDocument();

      const image = await screen.findByRole(
        "img",
        { name: "Diagram" },
        { timeout: MOUNT_TIMEOUT_MS }
      );
      expect(image.getAttribute("src")).toBe(RESOLVED_URL);
      expect(mockResolveMutateAsync).toHaveBeenCalledWith([ATTACHMENT_ID]);
      expect(placeholderIn(container)).toBeNull();
    },
    TEST_TIMEOUT_MS
  );
});
