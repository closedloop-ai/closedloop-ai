import { afterEach, describe, expect, it, vi } from "vitest";
import { hideNativeDragImage } from "../lib/grid-row-drag-image";

afterEach(() => {
  vi.useRealTimers();
});

describe("hideNativeDragImage", () => {
  it("hands setDragImage a canvas attached to the document, then removes it", () => {
    vi.useFakeTimers();
    const attachedAtCall: boolean[] = [];
    const setDragImage = vi.fn((image: Element) => {
      attachedAtCall.push(image.isConnected);
    });
    const dataTransfer = { setDragImage } as unknown as DataTransfer;

    hideNativeDragImage(dataTransfer);

    expect(setDragImage).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      0,
      0
    );
    expect(attachedAtCall).toEqual([true]);
    const [image] = setDragImage.mock.calls[0] ?? [];
    vi.runAllTimers();
    expect(image?.isConnected).toBe(false);
  });

  it("does nothing when the transfer cannot set a drag image", () => {
    const before = document.body.childElementCount;
    hideNativeDragImage({} as DataTransfer);
    expect(document.body.childElementCount).toBe(before);
  });
});
