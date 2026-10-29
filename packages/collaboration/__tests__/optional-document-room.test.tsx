// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptionalDocumentRoom } from "../client/optional-document-room";

const roomProviderCalls: { id: string; initialPresence: unknown }[] = [];
const updateMyPresence = vi.fn();

vi.mock("@liveblocks/react/suspense", () => ({
  RoomProvider: ({
    id,
    initialPresence,
    children,
  }: {
    id: string;
    initialPresence: unknown;
    children: ReactNode;
  }) => {
    roomProviderCalls.push({ id, initialPresence });
    return (
      <div data-room-id={id} data-testid="room">
        {children}
      </div>
    );
  },
  useUpdateMyPresence: () => updateMyPresence,
}));

afterEach(() => {
  roomProviderCalls.length = 0;
  updateMyPresence.mockReset();
});

describe("OptionalDocumentRoom", () => {
  it.each([null, undefined, ""])(
    "renders children without a room when roomId is %j",
    (roomId) => {
      render(
        <OptionalDocumentRoom roomId={roomId}>
          <span>child</span>
        </OptionalDocumentRoom>
      );
      expect(screen.getByText("child")).toBeInTheDocument();
      expect(screen.queryByTestId("room")).toBeNull();
      expect(roomProviderCalls).toEqual([]);
    }
  );

  it("wraps children in a DocumentRoom for the given roomId", () => {
    render(
      <OptionalDocumentRoom roomId="room-1">
        <span>child</span>
      </OptionalDocumentRoom>
    );
    const room = screen.getByTestId("room");
    expect(room).toHaveAttribute("data-room-id", "room-1");
    expect(room).toContainElement(screen.getByText("child"));
    expect(roomProviderCalls[0]).toEqual({
      id: "room-1",
      initialPresence: { readOnly: false },
    });
  });

  it("passes readOnly through to the room presence", () => {
    render(
      <OptionalDocumentRoom readOnly roomId="room-2">
        <span>child</span>
      </OptionalDocumentRoom>
    );
    expect(roomProviderCalls[0]).toEqual({
      id: "room-2",
      initialPresence: { readOnly: true },
    });
  });

  it("republishes readOnly presence when the same room flips between values", () => {
    const { rerender } = render(
      <OptionalDocumentRoom readOnly={false} roomId="room-3">
        <span>child</span>
      </OptionalDocumentRoom>
    );
    rerender(
      <OptionalDocumentRoom readOnly roomId="room-3">
        <span>child</span>
      </OptionalDocumentRoom>
    );
    rerender(
      <OptionalDocumentRoom readOnly={false} roomId="room-3">
        <span>child</span>
      </OptionalDocumentRoom>
    );

    expect(new Set(roomProviderCalls.map((call) => call.id))).toEqual(
      new Set(["room-3"])
    );
    expect(updateMyPresence.mock.calls).toEqual([
      [{ readOnly: false }],
      [{ readOnly: true }],
      [{ readOnly: false }],
    ]);
  });
});
