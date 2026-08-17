// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlinePresence, Presence } from "../client/presence";

const { mockUseOthers, mockUseSelf } = vi.hoisted(() => ({
  mockUseOthers: vi.fn(),
  mockUseSelf: vi.fn(),
}));

vi.mock("@liveblocks/react/suspense", () => ({
  useOthers: mockUseOthers,
  useSelf: mockUseSelf,
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
  AvatarImage: ({ alt, src }: { alt: string; src: string }) => (
    <span data-alt={alt} data-src={src} data-testid="avatar-image" />
  ),
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
    expect(screen.getByText("YO")).toBeInTheDocument();
    expect(screen.getByText("AL")).toBeInTheDocument();
    expect(screen.getByText("JA")).toBeInTheDocument();
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
    expect(screen.getByText("AN")).toBeInTheDocument();
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
