import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadAsMarkdown } from "../download-utils";

function setup() {
  const createObjectURL = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:mock-url");
  const revokeObjectURL = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => undefined);
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  const appendChildSpy = vi.spyOn(document.body, "appendChild");
  return { createObjectURL, revokeObjectURL, clickSpy, appendChildSpy };
}

function appendedAnchor(
  appendChildSpy: ReturnType<typeof vi.spyOn>
): HTMLAnchorElement {
  return appendChildSpy.mock.calls[0]?.[0] as HTMLAnchorElement;
}

describe("downloadAsMarkdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends .md to a filename that doesn't have it", () => {
    const { appendChildSpy } = setup();

    downloadAsMarkdown("# hello", "notes");

    expect(appendedAnchor(appendChildSpy).download).toBe("notes.md");
  });

  it("does not double-append .md when the filename already has it", () => {
    const { appendChildSpy } = setup();

    downloadAsMarkdown("# hello", "notes.md");

    expect(appendedAnchor(appendChildSpy).download).toBe("notes.md");
  });

  it("creates a text/markdown blob, wires the anchor to it, and clicks it", () => {
    const { createObjectURL, clickSpy, appendChildSpy } = setup();

    downloadAsMarkdown("# hello", "notes.md");

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("text/markdown");
    expect(appendedAnchor(appendChildSpy).href).toBe("blob:mock-url");
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it("revokes the created object URL exactly once", () => {
    const { createObjectURL, revokeObjectURL } = setup();

    downloadAsMarkdown("# hello", "notes.md");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:mock-url");
  });
});
