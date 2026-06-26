// @vitest-environment jsdom
import type { ThreadData } from "@liveblocks/client";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCopy = vi.fn().mockResolvedValue(true);
vi.mock("@repo/design-system/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => [null, mockCopy] as const,
}));

import { createLiveblocksUiMock } from "../__helpers__/liveblocks-ui-mock";

vi.mock("@liveblocks/react-ui", () => createLiveblocksUiMock());

import { CommentPermalinkProvider } from "../../comment-permalink-context";
import { LiveblocksCommentCard } from "../../sources/liveblocks-comment-card";

const COPY_LINK_LABEL_RE = /copy link/i;
const HIGHLIGHTED_RE = /highlighted/i;
const FROM_V_RE = /from v/;

function makeThread(overrides: Partial<ThreadData> = {}): ThreadData {
  return {
    type: "thread",
    id: "th_1",
    roomId: "room_1",
    createdAt: new Date("2026-05-18T14:00:00Z"),
    updatedAt: new Date("2026-05-18T14:00:00Z"),
    metadata: {},
    comments: [
      {
        type: "comment",
        id: "c_root",
        threadId: "th_1",
        roomId: "room_1",
        userId: "u_1",
        createdAt: new Date("2026-05-18T14:00:00Z"),
        body: undefined,
        reactions: [],
        attachments: [],
      },
    ],
    resolved: false,
    ...overrides,
  } as ThreadData;
}

function renderCard(
  props: Parameters<typeof LiveblocksCommentCard>[0],
  options?: { buildPermalinkUrl?: (id: string) => string }
) {
  return render(
    <CommentPermalinkProvider
      buildPermalinkUrl={options?.buildPermalinkUrl}
      scrollToThreadId={undefined}
    >
      <LiveblocksCommentCard {...props} />
    </CommentPermalinkProvider>
  );
}

describe("LiveblocksCommentCard", () => {
  beforeEach(() => {
    mockCopy.mockClear();
  });

  it("renders the thread", () => {
    renderCard({ thread: makeThread(), anchorPreview: null });
    expect(screen.getByTestId("lb-thread")).toBeInTheDocument();
  });

  it("renders the anchor preview chip when anchorPreview is set", () => {
    renderCard({
      thread: makeThread(),
      anchorPreview: "highlighted passage",
    });
    expect(screen.getByText("highlighted passage")).toBeInTheDocument();
  });

  it("omits the anchor preview when null", () => {
    renderCard({ thread: makeThread(), anchorPreview: null });
    expect(screen.queryByText(HIGHLIGHTED_RE)).toBeNull();
  });

  it("renders the version-attribution badge when versionLabel is set", () => {
    renderCard({
      thread: makeThread(),
      anchorPreview: null,
      versionLabel: "from v1",
    });
    expect(screen.getByText("from v1")).toBeInTheDocument();
  });

  it("omits the version badge when versionLabel is undefined", () => {
    renderCard({ thread: makeThread(), anchorPreview: null });
    expect(screen.queryByText(FROM_V_RE)).toBeNull();
  });

  it("calls onCommentClick when the card is clicked (mouse)", () => {
    const onCommentClick = vi.fn();
    renderCard({
      thread: makeThread(),
      anchorPreview: null,
      onCommentClick,
    });
    const card = screen.getByTestId("lb-thread").parentElement;
    if (card === null) {
      throw new Error("card container not found");
    }
    fireEvent.click(card);
    expect(onCommentClick).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onCommentClick on keyboard activation (Enter)", () => {
    const onCommentClick = vi.fn();
    renderCard({
      thread: makeThread(),
      anchorPreview: null,
      onCommentClick,
    });
    const card = screen.getByTestId("lb-thread").parentElement;
    if (card === null) {
      throw new Error("card container not found");
    }
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onCommentClick).not.toHaveBeenCalled();
  });

  describe("Copy Link affordance", () => {
    it("renders a Copy Link dropdown item when buildPermalinkUrl is provided", () => {
      renderCard(
        { thread: makeThread(), anchorPreview: null },
        { buildPermalinkUrl: (id) => `https://example.com/?thread=${id}` }
      );
      expect(screen.getByLabelText(COPY_LINK_LABEL_RE)).toBeInTheDocument();
    });

    it("omits Copy Link when buildPermalinkUrl is undefined", () => {
      renderCard({ thread: makeThread(), anchorPreview: null });
      expect(screen.queryByLabelText(COPY_LINK_LABEL_RE)).toBeNull();
    });

    it("writes the permalink URL to the clipboard when clicked", async () => {
      renderCard(
        { thread: makeThread(), anchorPreview: null },
        { buildPermalinkUrl: (id) => `https://example.com/?thread=${id}` }
      );
      const copyButton = screen.getByLabelText(COPY_LINK_LABEL_RE);
      fireEvent.click(copyButton);
      // useCopyToClipboard mock resolves true; allow microtasks to flush.
      await Promise.resolve();
      expect(mockCopy).toHaveBeenCalledWith("https://example.com/?thread=th_1");
    });
  });
});
