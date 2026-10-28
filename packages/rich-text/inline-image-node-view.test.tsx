// @vitest-environment jsdom

import {
  InlineImageLayout,
  parseInlineImageWidth,
} from "@repo/document-schema/inline-image-layout";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InlineImageExtension,
  InlineImageResolverContext,
} from "./inline-image-extension";

const mocks = vi.hoisted(() => ({
  nodeViewComponent: null as unknown,
}));

vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({
    children,
    className,
    "data-layout": dataLayout,
  }: Readonly<{
    children: ReactNode;
    className?: string;
    "data-layout"?: string;
  }>) => (
    <span className={className} data-layout={dataLayout}>
      {children}
    </span>
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
      resolveInlineImages: vi.fn().mockResolvedValue({ images: [] }),
      src: ATTACHMENT_SRC,
    });

    await waitFor(() =>
      expect(getPlaceholder().getAttribute("data-failed")).toBe("true")
    );

    rerender(
      createNodeViewElement({
        resolveInlineImages: vi.fn().mockRejectedValue(new Error("offline")),
        src: ATTACHMENT_SRC,
      })
    );
    await waitFor(() =>
      expect(getPlaceholder().getAttribute("data-failed")).toBe("true")
    );
  });

  it("leaves resolver-less, invalid, and non-string sources unresolved", () => {
    const resolveInlineImages = vi.fn();
    const { rerender } = renderNodeView({
      resolveInlineImages: undefined,
      src: ATTACHMENT_SRC,
    });

    expect(getPlaceholder().textContent).toBe("Image unavailable");
    expect(getPlaceholder().hasAttribute("data-failed")).toBe(false);

    rerender(
      createNodeViewElement({
        resolveInlineImages,
        src: "https://example.com/external.png",
      })
    );
    rerender(
      createNodeViewElement({
        resolveInlineImages,
        src: null,
      })
    );

    expect(resolveInlineImages).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });

  // ISS-9805. The fetch is keyed on the resolver's IDENTITY, which makes
  // referential stability a real obligation on the host rather than a
  // preference — see the `resolveInlineImages` prop doc in ./types. Both halves
  // are asserted together because either alone is satisfiable by a node view
  // that never re-fetches or by one that always does.
  it("re-fetches only when the host swaps the resolver identity", async () => {
    const stableResolver = vi
      .fn()
      .mockResolvedValue({ images: [resolvedImage()] });
    const { rerender } = renderNodeView({
      resolveInlineImages: stableResolver,
      src: ATTACHMENT_SRC,
    });
    await screen.findByRole("img", { name: "diagram.png" });

    rerender(
      createNodeViewElement({
        resolveInlineImages: stableResolver,
        src: ATTACHMENT_SRC,
      })
    );

    expect(stableResolver).toHaveBeenCalledOnce();
    expect(screen.getByRole("img", { name: "diagram.png" })).toBeTruthy();

    const rebuiltResolver = vi
      .fn()
      .mockResolvedValue({ images: [resolvedImage()] });
    rerender(
      createNodeViewElement({
        resolveInlineImages: rebuiltResolver,
        src: ATTACHMENT_SRC,
      })
    );

    await waitFor(() => expect(rebuiltResolver).toHaveBeenCalledOnce());
    expect(stableResolver).toHaveBeenCalledOnce();
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
      resolveInlineImages,
      src: ATTACHMENT_SRC,
    });
    await waitFor(() => expect(resolveInlineImages).toHaveBeenCalledOnce());

    rerender(
      createNodeViewElement({
        resolveInlineImages,
        src: "https://example.com/external.png",
      })
    );
    resolveRequest?.({ images: [resolvedImage()] });

    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(getPlaceholder().hasAttribute("data-failed")).toBe(false);
  });
});

describe("InlineImageExtension node view layout controls", () => {
  const originalSetPointerCapture = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "setPointerCapture"
  );
  const originalReleasePointerCapture = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "releasePointerCapture"
  );

  beforeEach(() => {
    // jsdom does not implement pointer capture.
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    restorePrototypeProperty("setPointerCapture", originalSetPointerCapture);
    restorePrototypeProperty(
      "releasePointerCapture",
      originalReleasePointerCapture
    );
  });

  it("applies the stored width and layout to the rendered image", async () => {
    renderNodeView({
      layout: InlineImageLayout.Center,
      resolveInlineImages: vi
        .fn()
        .mockResolvedValue({ images: [resolvedImage()] }),
      src: ATTACHMENT_SRC,
      width: 360,
    });

    const image = await screen.findByRole("img", { name: "diagram.png" });
    expect(image.style.width).toBe("360px");
    expect(
      image.closest(".inline-image-wrapper")?.getAttribute("data-layout")
    ).toBe(InlineImageLayout.Center);
  });

  it("shows the layout toolbar only for a selected image in an editable editor", async () => {
    const resolveInlineImages = vi
      .fn()
      .mockResolvedValue({ images: [resolvedImage()] });
    const { rerender } = renderNodeView({
      editable: false,
      resolveInlineImages,
      selected: true,
      src: ATTACHMENT_SRC,
    });
    await screen.findByRole("img", { name: "diagram.png" });
    expect(screen.queryByRole("button", { name: "Wrap left" })).toBeNull();

    rerender(
      createNodeViewElement({
        editable: true,
        resolveInlineImages,
        selected: false,
        src: ATTACHMENT_SRC,
      })
    );
    expect(screen.queryByRole("button", { name: "Wrap left" })).toBeNull();

    rerender(
      createNodeViewElement({
        editable: true,
        resolveInlineImages,
        selected: true,
        src: ATTACHMENT_SRC,
      })
    );
    expect(
      screen
        .getByRole("button", { name: "Inline" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Wrap left" })
        .getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("writes the chosen layout back to the node", async () => {
    const updateAttributes = vi.fn();
    renderNodeView({
      editable: true,
      resolveInlineImages: vi
        .fn()
        .mockResolvedValue({ images: [resolvedImage()] }),
      selected: true,
      src: ATTACHMENT_SRC,
      updateAttributes,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Wrap right" }));

    expect(updateAttributes).toHaveBeenCalledWith({
      layout: InlineImageLayout.WrapRight,
    });
  });

  it("previews a drag-resize and commits the final width on release", async () => {
    const updateAttributes = vi.fn();
    renderNodeView({
      editable: true,
      resolveInlineImages: vi
        .fn()
        .mockResolvedValue({ images: [resolvedImage()] }),
      selected: true,
      src: ATTACHMENT_SRC,
      updateAttributes,
      width: 200,
    });
    const image = await screen.findByRole("img", { name: "diagram.png" });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 200, height: 100 })
    );
    const handle = getResizeHandle();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 220, pointerId: 1 });

    expect(image.style.width).toBe("320px");
    expect(updateAttributes).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { clientX: 220, pointerId: 1 });

    expect(updateAttributes).toHaveBeenCalledWith({ width: 320 });
  });

  it("discards a cancelled drag without writing a width", async () => {
    const updateAttributes = vi.fn();
    renderNodeView({
      editable: true,
      resolveInlineImages: vi
        .fn()
        .mockResolvedValue({ images: [resolvedImage()] }),
      selected: true,
      src: ATTACHMENT_SRC,
      updateAttributes,
      width: 200,
    });
    const image = await screen.findByRole("img", { name: "diagram.png" });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 200, height: 100 })
    );
    const handle = getResizeHandle();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 220, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(image.style.width).toBe("200px");
    expect(updateAttributes).not.toHaveBeenCalled();
  });

  it("commits a clamped width for a press and release with no movement", async () => {
    // tamsinb, #8432: `width` started as the raw
    // `getBoundingClientRect` width and only passed through
    // `clampInlineImageWidth` on pointermove, so a press with no move committed
    // the unrounded rect width. `parseInlineImageWidth` rejects a fractional
    // value, so the node held a width nothing renders and the stored one was
    // gone from the markdown on the next save.
    const updateAttributes = vi.fn();
    renderNodeView({
      editable: true,
      resolveInlineImages: vi
        .fn()
        .mockResolvedValue({ images: [resolvedImage()] }),
      selected: true,
      src: ATTACHMENT_SRC,
      updateAttributes,
      width: 200,
    });
    const image = await screen.findByRole("img", { name: "diagram.png" });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 433.5, height: 100 })
    );
    const handle = getResizeHandle();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(updateAttributes).toHaveBeenCalledTimes(1);
    const committed = updateAttributes.mock.calls[0]?.[0]?.width as number;
    // Whatever the clamp's rounding rule is, the committed value has to be one
    // the parser accepts — that is the contract this case exists for.
    expect(parseInlineImageWidth(committed)).toBe(committed);
  });

  it("releases a preview width when the handle unmounts mid-drag", async () => {
    // whitlockk, #8432: a key press that moves the selection unmounts the handle
    // before `endDrag` can clear the preview. The parent stays mounted, so the
    // image kept rendering the unsaved width and masked later width updates.
    const updateAttributes = vi.fn();
    const editor = createFakeEditor(true);
    const view = renderNodeView({
      editable: true,
      editor,
      resolveInlineImages: vi
        .fn()
        .mockResolvedValue({ images: [resolvedImage()] }),
      selected: true,
      src: ATTACHMENT_SRC,
      updateAttributes,
      width: 200,
    });
    const image = await screen.findByRole("img", { name: "diagram.png" });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 200, height: 100 })
    );
    const handle = getResizeHandle();
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 320, pointerId: 1 });
    expect(image.style.width).not.toBe("200px");

    // Leaving edit mode unmounts the controls without an up or cancel event.
    act(() => {
      editor.setEditable(false);
    });

    expect(image.style.width).toBe("200px");
    expect(updateAttributes).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([
    [InlineImageLayout.WrapRight, "start", 40, 260],
    [InlineImageLayout.Center, "end", 160, 320],
    [InlineImageLayout.WrapLeft, "end", 160, 260],
  ])(
    "resizes a %s image from the %s edge at its layout's drag rate",
    async (layout, side, moveToX, expectedWidth) => {
      const updateAttributes = vi.fn();
      renderNodeView({
        editable: true,
        layout,
        resolveInlineImages: vi
          .fn()
          .mockResolvedValue({ images: [resolvedImage()] }),
        selected: true,
        src: ATTACHMENT_SRC,
        updateAttributes,
        width: 200,
      });
      const image = await screen.findByRole("img", { name: "diagram.png" });
      vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
        DOMRect.fromRect({ width: 200, height: 100 })
      );
      const handle = getResizeHandle();
      expect(handle.dataset.side).toBe(side);

      fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: moveToX, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: moveToX, pointerId: 1 });

      expect(updateAttributes).toHaveBeenCalledWith({ width: expectedWidth });
    }
  );

  it("caps a drag at the editor content width", async () => {
    const updateAttributes = vi.fn();
    const { container } = render(
      <div className="ProseMirror">
        {createNodeViewElement({
          editable: true,
          resolveInlineImages: vi
            .fn()
            .mockResolvedValue({ images: [resolvedImage()] }),
          selected: true,
          src: ATTACHMENT_SRC,
          updateAttributes,
          width: 200,
        })}
      </div>
    );
    const editorContent = container.querySelector<HTMLElement>(".ProseMirror");
    if (!editorContent) {
      throw new Error("editor content wrapper was not rendered");
    }
    Object.defineProperty(editorContent, "clientWidth", {
      configurable: true,
      value: 250,
    });
    const image = await screen.findByRole("img", { name: "diagram.png" });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 200, height: 100 })
    );
    const handle = getResizeHandle();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 400, pointerId: 1 });

    expect(updateAttributes).toHaveBeenCalledWith({ width: 250 });
  });

  it("ignores non-primary presses and pointer moves or releases with no drag", async () => {
    const updateAttributes = vi.fn();
    renderNodeView({
      editable: true,
      resolveInlineImages: vi
        .fn()
        .mockResolvedValue({ images: [resolvedImage()] }),
      selected: true,
      src: ATTACHMENT_SRC,
      updateAttributes,
      width: 200,
    });
    const image = await screen.findByRole("img", { name: "diagram.png" });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 200, height: 100 })
    );
    const handle = getResizeHandle();

    fireEvent.pointerMove(handle, { clientX: 220, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 220, pointerId: 1 });
    fireEvent.pointerDown(handle, { button: 2, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 220, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 220, pointerId: 1 });

    expect(image.style.width).toBe("200px");
    expect(updateAttributes).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.releasePointerCapture).not.toHaveBeenCalled();
  });

  it("hides the controls when the editor stops being editable", async () => {
    // tamsinb, #8432: `editor.isEditable` was read once per node-view render,
    // and `setEditable` does not re-render node views. The toolbar and handle
    // stayed up after the host left edit mode, and a click still ran
    // `updateAttributes` against a read-only document.
    const editor = createFakeEditor(true);
    renderNodeView({
      editable: true,
      editor,
      resolveInlineImages: vi
        .fn()
        .mockResolvedValue({ images: [resolvedImage()] }),
      selected: true,
      src: ATTACHMENT_SRC,
      width: 200,
    });
    await screen.findByRole("img", { name: "diagram.png" });
    expect(getResizeHandle()).toBeTruthy();

    act(() => {
      editor.setEditable(false);
    });

    expect(document.querySelector(".inline-image-resize-handle")).toBeNull();
  });
});

type InlineImageResolver = (
  ids: string[]
) => Promise<{ images: ReturnType<typeof resolvedImage>[] }>;

type NodeViewAttrs = {
  alt?: string | null;
  src?: unknown;
  width?: number | null;
  layout?: string | null;
};

type NodeViewTestProps = {
  node: { attrs: NodeViewAttrs };
  selected?: boolean;
  editor?: FakeEditor;
  updateAttributes?: (attrs: Record<string, unknown>) => void;
};

type NodeViewOptions = NodeViewAttrs & {
  resolveInlineImages?: InlineImageResolver;
  selected?: boolean;
  editable?: boolean;
  /** Supply one to drive `setEditable` mid-render; otherwise one is built. */
  editor?: FakeEditor;
  updateAttributes?: (attrs: Record<string, unknown>) => void;
};

/**
 * The editor surface the node view actually consumes. It carries `on`/`off`
 * because the view SUBSCRIBES to editability rather than reading the getter
 * once: `setEditable` emits `update` and `ReactNodeViewRenderer` does not
 * re-render a node view for it, so a stub without the emitter could not tell a
 * live subscription from a stale read.
 */
type FakeEditor = {
  isEditable: boolean;
  on: (event: string, handler: () => void) => void;
  off: (event: string, handler: () => void) => void;
  setEditable: (editable: boolean) => void;
};

function createFakeEditor(isEditable: boolean): FakeEditor {
  const handlers = new Map<string, Set<() => void>>();
  return {
    isEditable,
    on(event, handler) {
      const existing = handlers.get(event) ?? new Set<() => void>();
      existing.add(handler);
      handlers.set(event, existing);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    setEditable(editable) {
      this.isEditable = editable;
      for (const handler of handlers.get("update") ?? []) {
        handler();
      }
    },
  };
}

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
  const extension = InlineImageExtension.configure({});
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
  // The resolver reaches the node view through context, not through extension
  // options — see `InlineImageResolverContext` (ISS-9795).
  return (
    <InlineImageResolverContext.Provider value={options.resolveInlineImages}>
      <NodeView
        editor={options.editor ?? createFakeEditor(options.editable ?? false)}
        node={{
          attrs: {
            alt: options.alt,
            layout: options.layout,
            src: options.src,
            width: options.width,
          },
        }}
        selected={options.selected}
        updateAttributes={options.updateAttributes}
      />
    </InlineImageResolverContext.Provider>
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

function getResizeHandle(): HTMLElement {
  const handle = document.querySelector<HTMLElement>(
    ".inline-image-resize-handle"
  );
  if (!handle) {
    throw new Error("inline image resize handle was not rendered");
  }
  return handle;
}

function restorePrototypeProperty(
  key: "setPointerCapture" | "releasePointerCapture",
  descriptor: PropertyDescriptor | undefined
) {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, key, descriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, key);
  }
}
