import { fireEvent } from "storybook/test";

/** Build a drag payload for Storybook's DOM and real browser runtimes. */
export function createStoryDataTransfer() {
  if (typeof globalThis.DataTransfer === "function") {
    return new globalThis.DataTransfer();
  }
  const entries = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    types: [] as string[],
    getData: (type: string) => entries.get(type) ?? "",
    setData(type: string, value: string) {
      entries.set(type, value);
      this.types = Array.from(entries.keys());
    },
  };
}

/** Preserve pointer coordinates where a DOM runtime lacks DragEvent. */
export function fireStoryDrag(
  row: HTMLElement,
  type: "dragstart" | "dragover" | "drop",
  clientX: number,
  clientY: number,
  dataTransfer: ReturnType<typeof createStoryDataTransfer>
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  fireEvent(row, event);
}

/** Give a JSDOM row the same nonzero geometry the drop contract uses in a browser. */
export function storyRowDropRect(row: HTMLElement): DOMRect {
  const measured = row.getBoundingClientRect();
  if (measured.height > 0 && measured.bottom > measured.top) {
    return measured;
  }
  return {
    bottom: 140,
    height: 40,
    left: 0,
    right: 300,
    top: 100,
    width: 300,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  } as DOMRect;
}
