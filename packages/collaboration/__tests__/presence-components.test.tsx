// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlinePresence, Presence } from "../client/presence";

const { mockUseOthers, mockUseSelf, mockUseDocSyncRoom, mockUseDocSyncPeers } =
  vi.hoisted(() => ({
    mockUseOthers: vi.fn(),
    mockUseSelf: vi.fn(),
    mockUseDocSyncRoom: vi.fn(),
    mockUseDocSyncPeers: vi.fn(),
  }));

vi.mock("@liveblocks/react/suspense", () => ({
  useOthers: mockUseOthers,
  useSelf: mockUseSelf,
}));

vi.mock("../client/doc-sync-room", () => ({
  useIsOnDocSync: () => mockUseDocSyncRoom() !== undefined,
}));

vi.mock("../client/doc-sync-peers", () => ({
  useDocSyncPeers: mockUseDocSyncPeers,
}));

vi.mock("@repo/design-system/components/ui/avatar", () => ({
  Avatar: ({ children, ...props }: ComponentProps<"div">) => (
    <div data-testid="avatar" {...props}>
      {children}
    </div>
  ),
  AvatarFallback: ({ children, ...props }: ComponentProps<"span">) => (
    <span data-testid="avatar-fallback" {...props}>
      {children}
    </span>
  ),
  // ISS-8972: real Radix `AvatarImage` renders nothing when `src` is absent
  // (it never shows an `<img>` with no source) — this mock now matches that,
  // since the real component is called unconditionally (never conditionally
  // mounted) and only `src` says whether there is a picture.
  AvatarImage: ({ alt, src }: { alt: string; src?: string }) =>
    src ? (
      <span data-alt={alt} data-src={src} data-testid="avatar-image" />
    ) : null,
  // PersonAvatar (the presence avatar since 2026-10-22) also reaches these.
  AvatarStatus: () => null,
  avatarInitial: (text: string | null | undefined, fallback = "") => {
    const first = Array.from((text ?? "").trim())[0];
    return first ? first.toUpperCase() : fallback;
  },
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@repo/design-system/lib/utils", () => ({
  cn: (...values: (string | false | null | undefined)[]) =>
    values.filter(Boolean).join(" "),
}));

describe.each([
  ["Presence", Presence],
  ["InlinePresence", InlinePresence],
] as const)("%s", (_name, PresenceComponent) => {
  beforeEach(() => {
    mockUseOthers.mockReset();
    mockUseSelf.mockReset();
    mockUseSelf.mockReturnValue(null);
    mockUseDocSyncRoom.mockReset();
    mockUseDocSyncRoom.mockReturnValue(undefined);
    mockUseDocSyncPeers.mockReset();
    mockUseDocSyncPeers.mockReturnValue({
      others: [makeOther(9, { color: "teal", name: "Doc Sync Peer" })],
      self: null,
    });
  });

  it("reads awareness peers under a DocSyncRoom, filtering read-only ones", () => {
    mockUseDocSyncRoom.mockReturnValue({ room: null });
    mockUseOthers.mockReturnValue([
      makeOther(1, { color: "red", name: "Liveblocks Peer" }),
    ]);
    mockUseDocSyncPeers.mockReturnValue({
      others: [
        makeOther(2, { color: "blue", name: "Grace Hopper" }),
        makeOther(3, { color: "gray", name: "Historical Reader" }, true),
      ],
      self: { info: { color: "purple", name: "Ada Lovelace" } },
    });

    render(<PresenceComponent />);

    expect(screen.getAllByTestId("avatar")).toHaveLength(2);
    expect(screen.getByText("G")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.queryByText("L")).not.toBeInTheDocument();
    expect(screen.queryByText("H")).not.toBeInTheDocument();
  });

  it("reads Liveblocks outside a DocSyncRoom", () => {
    mockUseOthers.mockReturnValue([
      makeOther(1, { color: "red", name: "Liveblocks Peer" }),
    ]);

    render(<PresenceComponent />);

    expect(screen.getByText("L")).toBeInTheDocument();
    expect(screen.queryByText("D")).not.toBeInTheDocument();
  });

  it("renders nothing when there are no live collaborators", () => {
    mockUseOthers.mockReturnValue([
      makeOther(1, { name: "Read Only", color: "gray" }, true),
    ]);

    const { container } = render(<PresenceComponent />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders the current user and the three live collaborators before the overflow count", () => {
    mockUseSelf.mockReturnValue({
      info: { avatar: "self.png", color: "purple", name: "" },
    });
    mockUseOthers.mockReturnValue([
      makeOther(1, { color: "red", name: "Ada Lovelace" }),
      makeOther(2, { color: "blue", name: "Jane" }),
      makeOther(3, { color: "green", name: "?" }),
      makeOther(4, { avatar: "hidden.png", color: "orange", name: "Hidden" }),
      makeOther(5, { color: "gray", name: "Read Only" }, true),
    ]);

    render(<PresenceComponent />);

    expect(screen.getAllByTestId("avatar")).toHaveLength(4);
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("Y")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("J")).toBeInTheDocument();
    expect(screen.getAllByText("?").length).toBeGreaterThan(0);
    expect(screen.getByTestId("avatar-image")).toHaveAttribute(
      "data-alt",
      "You"
    );
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
  });

  it("uses the anonymous fallback and omits current-user and overflow UI", () => {
    mockUseOthers.mockReturnValue([
      makeOther(1, { color: "red", name: "" }),
      makeOther(2, {
        avatar: "grace.png",
        color: "blue",
        name: "Grace Hopper",
      }),
    ]);

    render(<PresenceComponent />);

    expect(screen.getAllByTestId("avatar")).toHaveLength(2);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-image")).toHaveAttribute(
      "data-alt",
      "Grace Hopper"
    );
    expect(screen.queryByText(plusPrefixPattern)).not.toBeInTheDocument();
  });
});

function makeOther(
  connectionId: number,
  info: { avatar?: string; color: string; name: string },
  readOnly = false
) {
  return {
    connectionId,
    info,
    presence: { cursor: null, readOnly, selection: null },
  };
}

const plusPrefixPattern = /^\+/;
