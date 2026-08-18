import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRichTextEditorHost = vi.fn(
  (_props: { scrollMode?: string; value?: string }) => null
);

vi.mock("@repo/collaboration/client/optional-comments", () => ({
  OptionalComments: () => null,
}));

vi.mock("@repo/rich-text/rich-text-toolbar", () => ({
  RichTextToolbar: () => null,
}));

vi.mock("../rich-text-editor-host", () => ({
  RichTextEditorHost: (props: { scrollMode?: string; value?: string }) =>
    mockRichTextEditorHost(props),
}));

import { EditorWithAnchoredComments } from "../editor-with-anchored-comments";

const SCROLL_CONTAINER_SELECTOR =
  "[class*='overflow-y-auto'],[class*='overflow-y-scroll']";

function countScrollContainers(container: HTMLElement): number {
  return container.querySelectorAll(SCROLL_CONTAINER_SELECTOR).length;
}

// The rule that hides the body's leading title repeat (ISS-5006). Scoped to a
// direct child of `.ProseMirror` so it can only ever reach the document's first
// top-level heading.
const HIDE_LEADING_TITLE_HEADING_CLASS =
  "[&_.ProseMirror>h1:first-child]:hidden";

function renderEditor(readOnly: boolean, hideLeadingTitleHeading = false) {
  return render(
    <EditorWithAnchoredComments
      editorUsesLiveblocksContent={false}
      hideLeadingTitleHeading={hideLeadingTitleHeading}
      onChange={() => undefined}
      readOnly={readOnly}
      value="Body copy."
    />
  );
}

function hasHideRule(container: HTMLElement): boolean {
  return Array.from(container.querySelectorAll("[class]")).some((node) =>
    node.classList.contains(HIDE_LEADING_TITLE_HEADING_CLASS)
  );
}

// Regression: this subtree used to declare its own scroll container. Nested
// inside the document editor's page-level scroller, it rendered a second
// scrollbar beside the page's own — the double scrollbars users saw in Chrome
// on macOS. The page owns scrolling; this subtree must never introduce one.
describe("EditorWithAnchoredComments scroll ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("declares no scroll container in read mode", () => {
    const { container } = renderEditor(true);

    expect(countScrollContainers(container)).toBe(0);
  });

  it("declares no scroll container in edit mode", () => {
    const { container } = renderEditor(false);

    expect(countScrollContainers(container)).toBe(0);
  });

  it("tells the editor host the page scrolls, so Tiptap adds no scroller of its own", () => {
    renderEditor(true);

    const props = mockRichTextEditorHost.mock.calls.at(-1)?.[0];
    expect(props?.scrollMode).toBe("outer");
  });
});

// ISS-5006: the artifact title rendered twice, back to back, at two sizes —
// once as the chrome's title and again as the body's leading H1. The host
// decides when the two are the same string; this asserts the decision reaches
// the DOM, and that nothing hides a heading when it should not.
describe("EditorWithAnchoredComments leading title heading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides the body's leading heading when the host says it repeats the title", () => {
    const { container } = renderEditor(true, true);

    expect(hasHideRule(container)).toBe(true);
  });

  it("hides nothing by default", () => {
    const { container } = renderEditor(true);

    expect(hasHideRule(container)).toBe(false);
  });

  it("passes the content through to the editor untouched either way", () => {
    renderEditor(true, true);

    // The hide is presentational only: the body the editor (and therefore any
    // save) sees still carries the heading.
    const props = mockRichTextEditorHost.mock.calls.at(-1)?.[0];
    expect(props?.value).toBe("Body copy.");
  });
});
