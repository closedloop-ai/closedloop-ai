import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const COMMENTS_TEST_ID = "optional-comments";

type CapturedCommentsProps = {
  roomId?: string | null;
};

const mockRichTextEditorHost = vi.fn(
  (_props: { scrollMode?: string; value?: string }) => null
);

/**
 * Renders a real node rather than `null`: with a null mock, "reaches the DOM"
 * is a claim about the parent's call list and nothing more (whitlockk, #7196). The
 * node is what lets the wrapper assertion below read the class the surface was
 * actually mounted under.
 */
const mockOptionalComments = vi.fn((_props: CapturedCommentsProps) => (
  <div data-testid={COMMENTS_TEST_ID} />
));

vi.mock("@repo/collaboration/client/optional-comments", () => ({
  OptionalComments: (props: CapturedCommentsProps) =>
    mockOptionalComments(props),
}));

const mockDocSyncFloatingToolbar = vi.fn((_props: { editor: unknown }) => null);

vi.mock("@repo/collaboration/client/doc-sync-floating-toolbar", () => ({
  DocSyncFloatingToolbar: (props: { editor: unknown }) =>
    mockDocSyncFloatingToolbar(props),
}));

const mockRichTextToolbar = vi.fn(
  (_props: { hasLiveblocksExtension: boolean }) => null
);

vi.mock("@repo/rich-text/rich-text-toolbar", () => ({
  RichTextToolbar: (props: { hasLiveblocksExtension: boolean }) =>
    mockRichTextToolbar(props),
}));

const docSyncProbe = vi.hoisted(() => ({
  state: undefined as { room: null } | undefined,
}));

vi.mock("@repo/collaboration/client/doc-sync-room", () => ({
  useIsOnDocSync: () => docSyncProbe.state !== undefined,
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

const ROOM_ID = "org-1:PRD-706";

function renderWithRoom(
  editorUsesLiveblocksContent: boolean,
  showComments = true
) {
  return render(
    <EditorWithAnchoredComments
      editorUsesLiveblocksContent={editorUsesLiveblocksContent}
      liveblocksRoomId={ROOM_ID}
      onChange={() => undefined}
      readOnly={false}
      showComments={showComments}
      value="Body copy."
    />
  );
}

// ISS-9849. Every comment surface reads the Liveblocks Tiptap extension's
// editor storage, which the host registers only when the editor takes its
// content from the room. `liveblocksRoomId` is slug-derived, so it is set on
// historical versions too — mounting on the room id alone put `FloatingComposer`
// in front of a plain editor and threw
// `Cannot read properties of undefined (reading 'pendingComment')` in prod.
describe("EditorWithAnchoredComments comment-surface mounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docSyncProbe.state = undefined;
  });

  // PLN-2189 AC-008: the composer needs the Liveblocks extension's storage,
  // which the doc-sync editor does not carry (ISS-9849).
  it("mounts no comment composer or Add Comment control under a DocSyncRoom", () => {
    docSyncProbe.state = { room: null };
    renderWithRoom(true);

    expect(mockOptionalComments).not.toHaveBeenCalled();
    expect(mockRichTextToolbar.mock.calls.at(-1)?.[0]).toMatchObject({
      hasLiveblocksExtension: false,
    });
  });

  it("keeps the Add Comment control on Liveblocks content outside a DocSyncRoom", () => {
    renderWithRoom(true);

    expect(mockRichTextToolbar.mock.calls.at(-1)?.[0]).toMatchObject({
      hasLiveblocksExtension: true,
    });
  });

  it("mounts no comment surface when the editor has no Liveblocks content, even with a room id", () => {
    renderWithRoom(false);

    expect(mockOptionalComments).not.toHaveBeenCalled();
  });

  // A breakpoint-scoped wrapper (`xl:hidden`, `hidden xl:block`) on the only
  // mount would strand the other breakpoint with no comment composer
  // (marisolashgrove, #7196), so the wrapper must carry no class at all.
  it("mounts the comment surface once, with the room, at every breakpoint", () => {
    const { getByTestId } = renderWithRoom(true);

    expect(getByTestId(COMMENTS_TEST_ID).parentElement?.className).toBe("");
    expect(mockOptionalComments).toHaveBeenCalledTimes(1);
    expect(mockOptionalComments.mock.calls[0]?.[0].roomId).toBe(ROOM_ID);
  });

  // PLN-2189 T-2.9: the toolbar renders itself only under a DocSyncRoom, so
  // the host mounts it wherever the editor is bound to the room's draft.
  it("mounts the doc-sync selection toolbar for an editor bound to the room's draft", () => {
    renderWithRoom(true);

    expect(mockDocSyncFloatingToolbar).toHaveBeenCalled();
  });

  it("mounts no doc-sync selection toolbar for a plain editor", () => {
    renderWithRoom(false);

    expect(mockDocSyncFloatingToolbar).not.toHaveBeenCalled();
  });

  it("hides the comment surface when comments are off", () => {
    const { getByTestId } = renderWithRoom(true, false);

    expect(getByTestId(COMMENTS_TEST_ID).parentElement?.className).toBe(
      "hidden"
    );
  });
});
