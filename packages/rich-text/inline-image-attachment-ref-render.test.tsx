// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TiptapEditorCore } from "./tiptap-editor-core";
import type {
  InlineImageResolver,
  ResolvedInlineImage,
  TiptapEditor,
} from "./types";

/**
 * ISS-8387. Written out here rather than imported from the module that builds
 * the ref, so a change to that builder cannot move this expectation with it.
 */
const BARE_ATTACHMENT_SCHEME = "attachment://";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const ATTACHMENT_SRC = `attachment://${ATTACHMENT_ID}`;
const RESOLVED_URL = "https://example.com/diagram.png";
const DOCUMENT_MARKDOWN = `Before\n\n![Diagram](${ATTACHMENT_SRC})\n\nAfter`;

function resolvedImage(): ResolvedInlineImage {
  return {
    attachmentId: ATTACHMENT_ID,
    expiresAt: "2026-09-01T00:00:00.000Z",
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 12,
    url: RESOLVED_URL,
  };
}

function documentElement(
  resolveInlineImages?: InlineImageResolver,
  onEditorReady?: (editor: TiptapEditor | null) => void
) {
  return (
    <TiptapEditorCore
      onChange={() => undefined}
      onEditorReady={onEditorReady}
      readOnly={true}
      resolveInlineImages={resolveInlineImages}
      value={DOCUMENT_MARKDOWN}
    />
  );
}

function renderDocument(resolveInlineImages?: InlineImageResolver) {
  let editor: TiptapEditor | null = null;
  const view = render(
    documentElement(resolveInlineImages, (instance) => {
      editor = instance;
    })
  );
  return { getEditor: () => editor as TiptapEditor | null, view };
}

function placeholderIn(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".inline-image-placeholder");
}

/** Every `src`/`href` the rendered subtree actually hands to the browser. */
function renderedUrlAttributes(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[src], [href]")).flatMap(
    (element) =>
      ["src", "href"]
        .map((name) => element.getAttribute(name))
        .filter((value): value is string => value !== null)
  );
}

describe("inline image attachment refs never reach the browser", () => {
  it("renders a placeholder instead of a bare attachment ref when the resolver is unavailable, and the same document renders an image once a resolver returns one", async () => {
    // Resolver-unavailable branch: the authoring flag is off, or its PostHog
    // evaluation failed closed, so the host passes no resolver at all.
    const withoutResolver = renderDocument(undefined);

    await waitFor(() =>
      expect(
        withoutResolver.view.container.querySelector(
          ".inline-image-placeholder"
        )
      ).not.toBeNull()
    );
    for (const url of renderedUrlAttributes(withoutResolver.view.container)) {
      expect(url.startsWith(BARE_ATTACHMENT_SCHEME)).toBe(false);
    }
    expect(
      withoutResolver.view.container.innerHTML.includes(
        `src="${BARE_ATTACHMENT_SCHEME}`
      )
    ).toBe(false);
    expect(withoutResolver.view.container.querySelector("img")).toBeNull();

    withoutResolver.view.unmount();

    // Positive sibling — without it the assertions above would also pass for a
    // component that renders nothing at all.
    const resolve: InlineImageResolver = vi
      .fn()
      .mockResolvedValue({ images: [resolvedImage()] });
    const withResolver = renderDocument(resolve);

    const image = await screen.findByRole("img", { name: "Diagram" });
    expect(image.getAttribute("src")).toBe(RESOLVED_URL);
    expect(resolve).toHaveBeenCalledWith([ATTACHMENT_ID]);
    expect(
      withResolver.view.container.querySelector(".inline-image-placeholder")
    ).toBeNull();
  });

  // ISS-9795. Both renders above start from a FRESH editor, so neither
  // exercises the case the fix is for: the editor is constructed once, before
  // the host's gate has settled, and the node views mounted in that window have
  // to follow the resolver afterwards. Nothing short of the DOM proves that —
  // an assertion on the channel itself passes for a channel nothing re-reads.
  // Both directions are pinned, and flag-off is the one that matters more,
  // because an image left on screen after reading is withdrawn is the failure
  // that looks like nothing happened.
  it("follows the resolver on already-mounted node views, in both directions", async () => {
    const resolve: InlineImageResolver = vi
      .fn()
      .mockResolvedValue({ images: [resolvedImage()] });
    const view = render(documentElement(undefined));

    await waitFor(() =>
      expect(placeholderIn(view.container)?.textContent).toBe(
        "Image unavailable (Diagram)"
      )
    );
    expect(resolve).not.toHaveBeenCalled();

    view.rerender(documentElement(resolve));

    const image = await screen.findByRole("img", { name: "Diagram" });
    expect(image.getAttribute("src")).toBe(RESOLVED_URL);
    expect(resolve).toHaveBeenCalledWith([ATTACHMENT_ID]);
    expect(placeholderIn(view.container)).toBeNull();

    view.rerender(documentElement(undefined));

    await waitFor(() =>
      expect(placeholderIn(view.container)?.textContent).toBe(
        "Image unavailable (Diagram)"
      )
    );
    expect(view.container.querySelector("img[src]")).toBeNull();
  });

  it("keeps the ref out of the serialized `src` the DOM serializer produces, while the stored markdown round-trips unchanged", async () => {
    const { getEditor } = renderDocument(undefined);

    await waitFor(() => expect(getEditor()).not.toBeNull());
    const html = getEditor()?.getHTML() ?? "";

    // `renderHTML` feeds ProseMirror's DOM serializer (clipboard, drag,
    // `getHTML`), which builds real elements — an `<img src="attachment://…">`
    // there is a CSP `img-src` violation, not a picture.
    expect(html.includes(`src="${BARE_ATTACHMENT_SCHEME}`)).toBe(false);
    expect(html.includes("<img")).toBe(false);

    // Positive sibling: the ref itself is still carried, so the node is not
    // simply being dropped on the floor.
    expect(html.includes(ATTACHMENT_SRC)).toBe(true);
    expect(getEditor()?.getMarkdown()).toBe(DOCUMENT_MARKDOWN);

    // Feeding the serializer's own output back is what pins the serializer and
    // the parser to the SAME attribute name. Copy and drag inside a document go
    // exactly this way, so a read side that does not match the write side drops
    // the image silently.
    getEditor()?.commands.setContent(html);
    expect(getEditor()?.getMarkdown()).toBe(DOCUMENT_MARKDOWN);
  });

  it("names the image it stands in for and marks only the in-flight state busy", async () => {
    let settle:
      | ((value: { images: ResolvedInlineImage[] }) => void)
      | undefined;
    const resolve: InlineImageResolver = vi.fn(
      () =>
        new Promise<{ images: ResolvedInlineImage[] }>((r) => {
          settle = r;
        })
    );
    const { view } = renderDocument(resolve);

    // In flight: the placeholder is the accessible name a reader gets INSTEAD
    // of the image, so it has to carry the alt text.
    const pending = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(
        ".inline-image-placeholder"
      );
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(pending.textContent).toBe("Loading image… (Diagram)");
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending.hasAttribute("data-failed")).toBe(false);

    settle?.({ images: [] });

    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLElement>(".inline-image-placeholder")
          ?.textContent
      ).toBe("Image unavailable (Diagram)")
    );
    const settled = view.container.querySelector<HTMLElement>(
      ".inline-image-placeholder"
    );
    expect(settled?.hasAttribute("aria-busy")).toBe(false);
    expect(settled?.getAttribute("data-failed")).toBe("true");
  });

  it("contains a hostile ref attribute instead of resolving or rendering it", async () => {
    const resolve: InlineImageResolver = vi
      .fn()
      .mockResolvedValue({ images: [] });
    const { getEditor, view } = renderDocument(resolve);
    await waitFor(() => expect(getEditor()).not.toBeNull());
    vi.mocked(resolve).mockClear();

    // `span[data-inline-image]` carries no value predicate, and the src
    // attribute prefers that attribute over a sibling `src` whichever rule
    // matched — so a pasted node can put anything here.
    getEditor()?.commands.setContent(
      '<p>a</p><span data-inline-image="javascript:alert(1)"></span>' +
        `<img data-inline-image="https://evil.example/x" src="${ATTACHMENT_SRC}">` +
        "<p>b</p>"
    );

    await waitFor(() =>
      expect(
        view.container.querySelector(".inline-image-placeholder")
      ).not.toBeNull()
    );
    expect(resolve).not.toHaveBeenCalled();
    // `img[src]`, not `img`: a paragraph ending in inline atoms makes
    // ProseMirror insert its own `<img class="ProseMirror-separator" alt="">`,
    // which carries no URL. The claim under test is that no image element is
    // handed one.
    expect(view.container.querySelector("img[src]")).toBeNull();
    for (const url of renderedUrlAttributes(view.container)) {
      expect(url).not.toBe("javascript:alert(1)");
      expect(url).not.toBe("https://evil.example/x");
    }
    // Neither value survives into stored markdown: `renderMarkdown` drops a ref
    // that is not an attachment ref.
    const markdown = getEditor()?.getMarkdown() ?? "";
    expect(markdown.includes("javascript:")).toBe(false);
    expect(markdown.includes("evil.example")).toBe(false);
  });

  it("still parses the pre-ISS-8387 `<img>` serialization back into an inline image", async () => {
    const { getEditor } = renderDocument(undefined);
    await waitFor(() => expect(getEditor()).not.toBeNull());

    getEditor()?.commands.setContent(
      `<p>Before</p><img src="${ATTACHMENT_SRC}" alt="Diagram"><p>After</p>`
    );

    expect(getEditor()?.getMarkdown()).toBe(DOCUMENT_MARKDOWN);
  });

  it("renders a stored layout and keeps it through markdown and clipboard HTML", async () => {
    const sizedMarkdown = `Before\n\n![Diagram](${ATTACHMENT_SRC} "width=320 align=left")\n\nAfter`;
    const { getEditor } = renderDocument(
      vi.fn().mockResolvedValue({ images: [resolvedImage()] })
    );
    await waitFor(() => expect(getEditor()).not.toBeNull());

    getEditor()?.commands.setContent(sizedMarkdown, {
      contentType: "markdown",
    });

    const image = await screen.findByRole("img", { name: "Diagram" });
    expect(image.style.width).toBe("320px");
    expect(
      image.closest(".inline-image-wrapper")?.getAttribute("data-layout")
    ).toBe("wrap-left");
    // Read-only documents render the layout without the editing controls.
    expect(screen.queryByRole("button", { name: "Wrap left" })).toBeNull();
    expect(getEditor()?.getMarkdown()).toBe(sizedMarkdown);

    const html = getEditor()?.getHTML() ?? "";
    expect(html).toContain('data-width="320"');
    expect(html).toContain('data-layout="wrap-left"');
    getEditor()?.commands.setContent(html);
    expect(getEditor()?.getMarkdown()).toBe(sizedMarkdown);
  });
});
