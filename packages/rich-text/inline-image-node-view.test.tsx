// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlineImageExtension } from "./inline-image-extension";

const mocks = vi.hoisted(() => ({
  nodeViewComponent: null as unknown,
}));

vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({
    children,
    className,
  }: Readonly<{ children: ReactNode; className?: string }>) => (
    <span className={className}>{children}</span>
  ),
  ReactNodeViewRenderer: (component: ComponentType<NodeViewTestProps>) => {
    mocks.nodeViewComponent = component;
    return vi.fn();
  },
}));

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const ATTACHMENT_SRC = `attachment://${ATTACHMENT_ID}`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("InlineImageExtension node view", () => {
  it("resolves attachment refs and prefers the stored alt text", async () => {
    const resolveInlineImages = vi.fn().mockResolvedValue({
      images: [resolvedImage()],
    });

    renderNodeView({
      alt: "Architecture diagram",
      enabled: true,
      resolveInlineImages,
      src: ATTACHMENT_SRC,
    });

    const image = await screen.findByRole("img", {
      name: "Architecture diagram",
    });
    expect(image.getAttribute("src")).toBe("https://example.com/diagram.png");
    expect(resolveInlineImages).toHaveBeenCalledWith([ATTACHMENT_ID]);
  });

  it("falls back to the resolved filename when alt text is absent", async () => {
    renderNodeView({
      alt: null,
      enabled: true,
      resolveInlineImages: vi.fn().mockResolvedValue({
        images: [resolvedImage()],
      }),
      src: ATTACHMENT_SRC,
    });

    expect(
      await screen.findByRole("img", { name: "diagram.png" })
    ).toBeTruthy();
  });

  it("marks missing and rejected resolutions as failed", async () => {
    const { rerender } = renderNodeView({
      enabled: true,
      resolveInlineImages: vi.fn().mockResolvedValue({ images: [] }),
      src: ATTACHMENT_SRC,
    });

    await waitFor(() =>
      expect(getPlaceholder().getAttribute("data-failed")).toBe("true")
    );

    rerender(
      createNodeViewElement({
        enabled: true,
        resolveInlineImages: vi.fn().mockRejectedValue(new Error("offline")),
        src: ATTACHMENT_SRC,
      })
    );
    await waitFor(() =>
      expect(getPlaceholder().getAttribute("data-failed")).toBe("true")
    );
  });

  it("leaves disabled, invalid, and non-string sources unresolved", () => {
    const resolveInlineImages = vi.fn();
    const { rerender } = renderNodeView({
      enabled: false,
      resolveInlineImages,
      src: ATTACHMENT_SRC,
    });

    expect(getPlaceholder().textContent).toBe("Image unavailable");
    expect(getPlaceholder().hasAttribute("data-failed")).toBe(false);

    rerender(
      createNodeViewElement({
        enabled: true,
        resolveInlineImages,
        src: "https://example.com/external.png",
      })
    );
    rerender(
      createNodeViewElement({
        enabled: true,
        resolveInlineImages,
        src: null,
      })
    );

    expect(resolveInlineImages).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("ignores a resolution that completes after the node source changes", async () => {
    let resolveRequest:
      | ((value: { images: ReturnType<typeof resolvedImage>[] }) => void)
      | undefined;
    const resolveInlineImages = vi.fn(
      () =>
        new Promise<{ images: ReturnType<typeof resolvedImage>[] }>(
          (resolve) => {
            resolveRequest = resolve;
          }
        )
    );
    const { rerender } = renderNodeView({
      enabled: true,
      resolveInlineImages,
      src: ATTACHMENT_SRC,
    });
    await waitFor(() => expect(resolveInlineImages).toHaveBeenCalledOnce());

    rerender(
      createNodeViewElement({
        enabled: false,
        resolveInlineImages,
        src: ATTACHMENT_SRC,
      })
    );
    resolveRequest?.({ images: [resolvedImage()] });

    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(getPlaceholder().hasAttribute("data-failed")).toBe(false);
  });
});

type InlineImageResolver = (
  ids: string[]
) => Promise<{ images: ReturnType<typeof resolvedImage>[] }>;

type NodeViewTestProps = {
  extension: {
    options: {
      enabled: boolean;
      resolveInlineImages?: InlineImageResolver;
    };
  };
  node: { attrs: { alt?: string | null; src?: unknown } };
};

type NodeViewOptions = {
  alt?: string | null;
  enabled: boolean;
  resolveInlineImages?: InlineImageResolver;
  src?: unknown;
};

function resolvedImage() {
  return {
    attachmentId: ATTACHMENT_ID,
    expiresAt: "2026-08-08T00:00:00.000Z",
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 12,
    url: "https://example.com/diagram.png",
  };
}

function getNodeViewComponent(): ComponentType<NodeViewTestProps> {
  const extension = InlineImageExtension.configure({ enabled: true });
  const addNodeView = extension.config.addNodeView;
  if (!addNodeView) {
    throw new Error("inline image node view is not configured");
  }
  addNodeView.call(extension as never);
  if (!mocks.nodeViewComponent) {
    throw new Error("inline image node view component was not captured");
  }
  return mocks.nodeViewComponent as ComponentType<NodeViewTestProps>;
}

function createNodeViewElement(options: NodeViewOptions) {
  const NodeView = getNodeViewComponent();
  return (
    <NodeView
      extension={{
        options: {
          enabled: options.enabled,
          resolveInlineImages: options.resolveInlineImages,
        },
      }}
      node={{ attrs: { alt: options.alt, src: options.src } }}
    />
  );
}

function renderNodeView(options: NodeViewOptions) {
  return render(createNodeViewElement(options));
}

function getPlaceholder(): HTMLElement {
  const placeholder = document.querySelector<HTMLElement>(
    ".inline-image-placeholder"
  );
  if (!placeholder) {
    throw new Error("inline image placeholder was not rendered");
  }
  return placeholder;
}
