// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePrewarmDocumentRoom } from "../client/use-prewarm-document-room";

const room = { id: "the-room" };
const leave = vi.fn();
const enterRoom = vi.fn(() => ({ room, leave }));
const getYjsProviderForRoom = vi.fn();

vi.mock("@liveblocks/react/suspense", () => ({
  useClient: () => ({ enterRoom }),
}));

vi.mock("@liveblocks/yjs", () => ({
  getYjsProviderForRoom: (...args: unknown[]) => getYjsProviderForRoom(...args),
}));

function Prewarm({ roomId }: { roomId: string | null }) {
  usePrewarmDocumentRoom(roomId);
  return null;
}

describe("usePrewarmDocumentRoom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins the room as a read-only viewer and starts its Y.Doc load", () => {
    render(<Prewarm roomId="org-1:artifact:ISS-1" />);

    // Read-only keeps the warming connection out of other users' avatar stack
    // until the editor itself mounts and publishes the real value.
    expect(enterRoom).toHaveBeenCalledWith("org-1:artifact:ISS-1", {
      initialPresence: { readOnly: true },
    });
    // Exactly the room it joined, and no options: the editor's Tiptap
    // extension adopts this cached provider, so it must be the provider the
    // extension would have created itself.
    expect(getYjsProviderForRoom.mock.calls).toEqual([[room]]);
  });

  it("leaves the room when it unmounts", () => {
    const { unmount } = render(<Prewarm roomId="org-1:artifact:ISS-1" />);
    expect(leave).not.toHaveBeenCalled();

    unmount();

    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("joins nothing while the room is not knowable", () => {
    const { rerender } = render(<Prewarm roomId={null} />);
    expect(enterRoom).not.toHaveBeenCalled();
    expect(getYjsProviderForRoom).not.toHaveBeenCalled();

    // The same instance joins as soon as a room is named, so the negative
    // above is not satisfied by a hook that never joins anything.
    rerender(<Prewarm roomId="org-1:artifact:ISS-1" />);
    expect(enterRoom).toHaveBeenCalledTimes(1);
  });
});
