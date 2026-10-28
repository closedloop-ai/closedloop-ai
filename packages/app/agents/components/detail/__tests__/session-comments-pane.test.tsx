import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import { traceTextAnchorToCommentAnchor } from "@repo/api/src/types/comment-anchor";
import { CommentsPaneToggle } from "@repo/app/shared/components/comments/comments-pane-toggle";
import {
  CommentsPaneOpenKey,
  CommentsPaneWidthKey,
} from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_ID,
  fakeCommentsSource,
  ORG_ID,
} from "../../../../shared/comments/__tests__/comments-test-source";
import {
  FULL_CAPABILITIES,
  makeThread,
  traceAnchor,
} from "../../../../shared/components/comments/comments-pane.fixtures";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  SessionCommentsPaneContent,
  type SessionCommentsPaneProps,
} from "../session-comments-pane";

/** The pane's heading carries its count, so it is matched by its leading word. */
const COMMENTS_HEADING = /^Comments/;

const SESSION_ID = "session-a";
const REVEAL_ROW = 9;
const PASSAGE = "pnpm turbo typecheck --concurrency=2";
const SELECTION: TraceTextAnchor = {
  endOffset: 4,
  row: 3,
  selectedText: "pnpm",
  sessionId: SESSION_ID,
  sourceText: "pnpm",
  startOffset: 0,
  traceId: "trace-1",
  turnId: "turn-3",
};

function renderPane(
  overrides: Partial<SessionCommentsPaneProps> = {},
  source = fakeCommentsSource([
    makeThread({
      anchor: traceAnchor(PASSAGE, { row: REVEAL_ROW, sessionId: SESSION_ID }),
      artifactId: ARTIFACT_ID,
      id: "thread-1",
    }),
  ]),
  { withHeaderButton = false } = {}
) {
  const order: string[] = [];
  const props: SessionCommentsPaneProps = {
    onRevealedAnchorChange: vi.fn(),
    onTraceSelectionUsed: vi.fn(),
    selectTabThenReveal: vi.fn((tab, reveal) => {
      order.push(`select:${tab}`);
      reveal();
    }),
    sessionId: SESSION_ID,
    traceJump: { current: (row) => order.push(`jump:${row}`) },
    traceSelection: null,
    visible: true,
    ...overrides,
  };
  const view = render(
    <AppCoreStoryProviders>
      {withHeaderButton ? (
        <CommentsPaneToggle openKey={CommentsPaneOpenKey.Session} paneOnTab />
      ) : null}
      <SessionCommentsPaneContent
        {...props}
        dataSource={source}
        organizationId={ORG_ID}
      />
    </AppCoreStoryProviders>
  );
  return { order, props, source, view };
}

describe("SessionCommentsPaneContent (PLN-2162 M6.1)", () => {
  afterEach(() => {
    globalThis.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("selects the Sessions tab before it jumps to a revealed thread's row", async () => {
    const user = userEvent.setup();
    const { order, props } = renderPane();

    await user.click(
      await screen.findByRole("button", { name: `Jump to ${PASSAGE}` })
    );

    expect(order).toEqual([
      `select:${ArtifactDetailTab.Sessions}`,
      `jump:${REVEAL_ROW}`,
    ]);
    expect(props.onRevealedAnchorChange).toHaveBeenCalledWith(
      expect.objectContaining({ row: REVEAL_ROW, selectedText: PASSAGE })
    );
  });

  it("anchors a new thread to the trace selection on the Session's own collection", async () => {
    const user = userEvent.setup();
    const source = fakeCommentsSource([]);
    source.createThread.mockImplementation((artifactId, request) =>
      Promise.resolve(
        makeThread({
          anchor: request.anchor,
          artifactId,
          id: "created",
        })
      )
    );
    const { props } = renderPane({ traceSelection: SELECTION }, source);

    const composer = await screen.findByRole("textbox", {
      name: "Comment on pnpm",
    });
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, "Why two passes?");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(source.createThread).toHaveBeenCalledExactlyOnceWith(
        ARTIFACT_ID,
        expect.objectContaining({
          anchor: traceTextAnchorToCommentAnchor(SELECTION),
          body: "Why two passes?",
        })
      )
    );
    expect(source.list).toHaveBeenCalledWith(SESSION_ID, expect.anything());
    await waitFor(() =>
      expect(props.onTraceSelectionUsed).toHaveBeenCalledOnce()
    );
  });

  it("keeps a passage selected while a trace-anchored post is in flight", async () => {
    const user = userEvent.setup();
    const source = fakeCommentsSource([]);
    let settle: () => void = () => undefined;
    source.createThread.mockImplementation(
      (artifactId, request) =>
        new Promise((resolve) => {
          settle = () =>
            resolve(
              makeThread({
                anchor: request.anchor,
                artifactId,
                id: "created",
              })
            );
        })
    );
    const { props, view } = renderPane({ traceSelection: SELECTION }, source);

    const composer = await screen.findByRole("textbox", {
      name: "Comment on pnpm",
    });
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, "Why two passes?");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(source.createThread).toHaveBeenCalledOnce());

    view.rerender(
      <AppCoreStoryProviders>
        <SessionCommentsPaneContent
          {...props}
          dataSource={source}
          organizationId={ORG_ID}
          traceSelection={{ ...SELECTION, row: 4, turnId: "turn-4" }}
        />
      </AppCoreStoryProviders>
    );
    await act(async () => {
      settle();
      await Promise.resolve();
    });

    expect(await screen.findByText("Body of created")).toBeVisible();
    await act(async () => {
      await Promise.resolve();
    });
    expect(props.onTraceSelectionUsed).not.toHaveBeenCalled();
  });

  it("opens for a new trace selection without writing the saved preference (ISS-12300 D6)", async () => {
    globalThis.localStorage.setItem(SESSION_OPEN, JSON.stringify(false));
    const { props, source, view } = renderPane();
    await waitFor(() => expect(source.list).toHaveBeenCalled());
    // Hidden is hidden: no collapsed strip is left behind (ISS-12300 D3).
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("button", { name: LEGACY_STRIP })).toBeNull();

    view.rerender(
      <AppCoreStoryProviders>
        <SessionCommentsPaneContent
          {...props}
          dataSource={source}
          organizationId={ORG_ID}
          traceSelection={SELECTION}
        />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByRole("heading", { name: COMMENTS_HEADING })
    ).toBeVisible();
    expect(globalThis.localStorage.getItem(SESSION_OPEN)).toBe("false");
  });

  it("lands an addressed link on its thread through a hidden pane, without writing the saved preference (ISS-11004)", async () => {
    globalThis.localStorage.setItem(SESSION_OPEN, JSON.stringify(false));
    renderPane({ addressedThreadId: "thread-1" });

    const body = await screen.findByText("Body of thread-1");
    expect(body.closest("[aria-current='true']")).not.toBeNull();
    expect(globalThis.localStorage.getItem(SESSION_OPEN)).toBe("false");
  });

  it("scrolls a cold-loaded address to its thread once the list lands (ISS-11004)", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const source = fakeCommentsSource();
    let land: () => void = () => undefined;
    source.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = () =>
            resolve({
              artifactId: ARTIFACT_ID,
              capabilities: FULL_CAPABILITIES,
              nextCursor: null,
              threads: [
                makeThread({ artifactId: ARTIFACT_ID, id: "thread-1" }),
              ],
            });
        })
    );
    renderPane({ addressedThreadId: "thread-1" }, source);
    await waitFor(() => expect(source.list).toHaveBeenCalled());

    await act(async () => {
      land();
      await Promise.resolve();
    });

    const card = (await screen.findByText("Body of thread-1")).closest(
      "[data-thread-id='thread-1']"
    );
    await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(card));
    expect(card?.querySelector("[aria-current='true']")).not.toBeNull();
  });

  it("starts hidden at a narrow width, where the header button opens it as a sheet", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string): MediaQueryList => ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      })
    );
    const user = userEvent.setup();
    renderPane({}, undefined, { withHeaderButton: true });

    const show = await screen.findByRole("button", { name: SHOW });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: LEGACY_STRIP })).toBeNull();

    await user.click(show);
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("is shown and hidden by the header button, and renders nothing off the Sessions tab", async () => {
    const user = userEvent.setup();
    const { source, view, props } = renderPane({}, undefined, {
      withHeaderButton: true,
    });
    expect(
      await screen.findByRole("heading", { name: COMMENTS_HEADING })
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: HIDE }));
    expect(
      screen.queryByRole("heading", { name: COMMENTS_HEADING })
    ).toBeNull();
    expect(globalThis.localStorage.getItem(SESSION_OPEN)).toBe("false");
    await user.click(screen.getByRole("button", { name: SHOW }));
    expect(
      await screen.findByRole("heading", { name: COMMENTS_HEADING })
    ).toBeVisible();

    view.rerender(
      <AppCoreStoryProviders>
        <SessionCommentsPaneContent
          {...props}
          dataSource={source}
          organizationId={ORG_ID}
          visible={false}
        />
      </AppCoreStoryProviders>
    );
    expect(
      screen.queryByRole("heading", { name: COMMENTS_HEADING })
    ).toBeNull();
  });

  it("carries its width to the next Session and leaves the Branch keys alone (ISS-12300 D2)", async () => {
    const { view } = renderPane();
    const separator = await screen.findByRole("separator", {
      name: "Resize comments rail",
    });
    fireEvent.keyDown(separator, { key: "End" });
    expect(globalThis.localStorage.getItem(SESSION_WIDTH)).toBe("560");
    view.unmount();

    renderPane({ sessionId: "session-b" });
    expect(
      await screen.findByRole("separator", { name: "Resize comments rail" })
    ).toHaveAttribute("aria-valuenow", "560");
    for (const key of [
      ...Object.values(CommentsPaneOpenKey),
      ...Object.values(CommentsPaneWidthKey),
    ]) {
      if (key !== SESSION_OPEN && key !== SESSION_WIDTH) {
        expect(globalThis.localStorage.getItem(key)).toBeNull();
      }
    }
  });
});

const SESSION_OPEN = CommentsPaneOpenKey.Session;
const SESSION_WIDTH = CommentsPaneWidthKey.Session;
const SHOW = "Show comments rail";
const HIDE = "Hide comments rail";
/** The legacy rail's collapsed strip, which the shell pane no longer has. */
const LEGACY_STRIP = "Show comments panel";
