// @vitest-environment jsdom
import type { ThreadData } from "@liveblocks/client";
import { FOCUS_WITHIN_RING_CLASS } from "@repo/app/shared/lib/focus-within-ring";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCopy = vi.fn().mockResolvedValue(true);
vi.mock("@repo/design-system/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => [null, mockCopy] as const,
}));

const mockToastSuccess = vi.fn();
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: (message: string) => mockToastSuccess(message) },
}));

import { createLiveblocksUiMock } from "../__helpers__/liveblocks-ui-mock";

vi.mock("@liveblocks/react-ui", () => createLiveblocksUiMock());

// The DS chrome override (`LiveblocksDsComment`) resolves the author via
// `useUser`; stub it so the card can render outside a RoomProvider.
vi.mock("@liveblocks/react", () => ({
  useUser: () => ({ user: undefined, isLoading: true, error: undefined }),
}));

import { CommentPermalinkProvider } from "../../comment-permalink-context";
import { LiveblocksCommentCard } from "../../sources/liveblocks-comment-card";

const COPY_LINK_LABEL_RE = /copy link/i;
const HIGHLIGHTED_RE = /highlighted/i;
const FROM_V_RE = /from v/;
const WHITESPACE_RE = /\s+/;

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
    mockToastSuccess.mockClear();
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

  it("rings the card on its own keyboard focus, not on any focus inside it", () => {
    const { container } = renderCard({
      thread: makeThread(),
      anchorPreview: null,
    });
    const classes =
      container
        .querySelector('[data-thread-id="th_1"]')
        ?.className.split(WHITESPACE_RE) ?? [];

    expect(classes).toEqual(
      expect.arrayContaining(CHIP_FOCUS_RING_CLASS.split(" "))
    );
    expect(classes.filter((c) => c.startsWith("focus-within:"))).toEqual([]);
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

  describe("composer open state", () => {
    function cardElement(): HTMLElement {
      const card = screen.getByTestId("lb-thread").closest("[tabindex]");
      if (!(card instanceof HTMLElement)) {
        throw new Error("card container not found");
      }
      return card;
    }

    it("ignores repeat clicks and key activation once the composer is open", () => {
      const onCommentClick = vi.fn();
      renderCard({ thread: makeThread(), anchorPreview: null, onCommentClick });
      const card = cardElement();
      expect(card.getAttribute("tabindex")).toBe("0");
      fireEvent.click(card);
      expect(card.getAttribute("tabindex")).toBe("-1");
      fireEvent.click(card);
      fireEvent.keyDown(card, { key: "Enter" });
      expect(onCommentClick).toHaveBeenCalledTimes(1);
      expect(card.getAttribute("tabindex")).toBe("-1");
    });

    it("rings the card while focus is inside the composer, and only then", () => {
      renderCard(
        { thread: makeThread(), anchorPreview: null },
        { buildPermalinkUrl: (id) => `https://example.com/?thread=${id}` }
      );
      const card = cardElement();
      const focusWithinClasses = () =>
        card.className
          .split(WHITESPACE_RE)
          .filter((c) => c.startsWith("focus-within:"));

      fireEvent.click(card);
      act(() => card.focus());
      expect(focusWithinClasses()).toEqual([]);

      act(() => screen.getByLabelText(COPY_LINK_LABEL_RE).focus());
      expect(focusWithinClasses()).toEqual([]);

      const editor = screen.getByTestId("lb-composer-editor");
      act(() => editor.focus());
      expect(focusWithinClasses()).toEqual(FOCUS_WITHIN_RING_CLASS.split(" "));

      act(() => editor.blur());
      expect(focusWithinClasses()).toEqual([]);
    });

    it("opens the composer on Enter", () => {
      renderCard({ thread: makeThread(), anchorPreview: null });
      const card = cardElement();
      fireEvent.keyDown(card, { key: "Enter" });
      expect(card.getAttribute("tabindex")).toBe("-1");
    });

    it("keeps the composer open for pointerdown inside the card or a Liveblocks portal", () => {
      renderCard({ thread: makeThread(), anchorPreview: null });
      const card = cardElement();
      fireEvent.click(card);
      const portal = document.createElement("div");
      portal.className = "lb-dropdown";
      const portalChild = document.createElement("span");
      portal.append(portalChild);
      document.body.append(portal);
      try {
        fireEvent.pointerDown(screen.getByTestId("lb-thread"));
        fireEvent.pointerDown(portalChild);
        document.dispatchEvent(new Event("pointerdown"));
        expect(card.getAttribute("tabindex")).toBe("-1");
      } finally {
        portal.remove();
      }
    });

    it("closes the composer on pointerdown outside the card", () => {
      renderCard({ thread: makeThread(), anchorPreview: null });
      const card = cardElement();
      fireEvent.click(card);
      fireEvent.pointerDown(document.body);
      expect(card.getAttribute("tabindex")).toBe("0");
    });
  });

  it("toasts only when the clipboard write succeeds", async () => {
    const buildPermalinkUrl = (id: string) =>
      `https://example.com/?thread=${id}`;
    renderCard(
      { thread: makeThread(), anchorPreview: null },
      { buildPermalinkUrl }
    );
    mockCopy.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByLabelText(COPY_LINK_LABEL_RE));
    await waitFor(() => expect(mockCopy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(COPY_LINK_LABEL_RE));
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("Link copied")
    );
  });
});
