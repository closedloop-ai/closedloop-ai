// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConstrainFloatingWithinEditor } from "../client/use-constrain-floating-within-editor";

describe("useConstrainFloatingWithinEditor", () => {
  let documentIsHidden = false;

  beforeEach(() => {
    document.body.innerHTML = "";
    documentIsHidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(
      () => documentIsHidden
    );
    TestMutationObserver.instances = [];
    vi.stubGlobal("MutationObserver", TestMutationObserver);
    vi.stubGlobal("DOMMatrixReadOnly", TestDOMMatrixReadOnly);
    vi.stubGlobal("DOMMatrix", TestDOMMatrix);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("does not install DOM observers when the editor is absent", () => {
    const { unmount } = renderHook(() =>
      useConstrainFloatingWithinEditor(undefined)
    );

    expect(TestMutationObserver.instances).toHaveLength(0);
    unmount();
  });

  it("clamps every visible floating shape to the editor boundary", () => {
    const { editor } = createEditorBoundary(rect(0, 0, 100, 100));
    const upperLeft = createFloatingElement(
      "lb-tiptap-floating-composer",
      rect(-10, -20, 40, 40),
      "matrix(1, 0, 0, 1, 4, 5)"
    );
    const lowerRight = createFloatingElement(
      "lb-tiptap-floating-toolbar",
      rect(80, 80, 30, 30),
      "matrix(1, 0, 0, 1, 1, 2)"
    );
    const oversized = createFloatingElement(
      "lb-tiptap-floating-threads",
      rect(20, 30, 100, 100),
      "matrix(1, 0, 0, 1, 0, 0)"
    );
    const inBounds = createFloatingElement(
      "",
      rect(20, 20, 20, 20),
      "matrix(1, 0, 0, 1, 3, 4)",
      "floating-toolbar"
    );
    const zeroSize = createFloatingElement(
      "",
      rect(0, 0, 0, 0),
      "matrix(1, 0, 0, 1, 6, 7)",
      "floating-composer"
    );
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("lb-tiptap-floating-toolbar");
    document.body.append(svg);

    renderHook(() => useConstrainFloatingWithinEditor(editor as never));

    expect(upperLeft.style.transform).toBe("matrix(1, 0, 0, 1, 22, 33)");
    expect(lowerRight.style.transform).toBe("matrix(1, 0, 0, 1, -17, -16)");
    expect(oversized.style.transform).toBe("matrix(1, 0, 0, 1, -12, -22)");
    expect(inBounds.style.transform).toBe("matrix(1, 0, 0, 1, 3, 4)");
    expect(zeroSize.style.transform).toBe("matrix(1, 0, 0, 1, 6, 7)");
  });

  it("leaves overflow unchanged when there is no usable transform matrix", () => {
    const { editor } = createEditorBoundary(rect(0, 0, 100, 100));
    const none = createFloatingElement(
      "lb-tiptap-floating-toolbar",
      rect(-10, -10, 20, 20),
      "none"
    );
    const empty = createFloatingElement(
      "lb-tiptap-floating-composer",
      rect(-10, -10, 20, 20),
      ""
    );
    const invalid = createFloatingElement(
      "lb-tiptap-floating-threads",
      rect(-10, -10, 20, 20),
      "invalid"
    );
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          transform:
            element === invalid
              ? "invalid"
              : (element as HTMLElement).style.transform,
        }) as CSSStyleDeclaration
    );

    renderHook(() => useConstrainFloatingWithinEditor(editor as never));

    expect(none.style.transform).toBe("none");
    expect(empty.style.transform).toBe("");
    expect(invalid.style.transform).toBe("");
  });

  it("leaves overflow unchanged when DOMMatrixReadOnly is unavailable", () => {
    const { editor } = createEditorBoundary(rect(0, 0, 100, 100));
    const floating = createFloatingElement(
      "lb-tiptap-floating-toolbar",
      rect(-10, -10, 20, 20),
      "matrix(1, 0, 0, 1, 2, 3)"
    );
    vi.stubGlobal("DOMMatrixReadOnly", undefined);

    renderHook(() => useConstrainFloatingWithinEditor(editor as never));

    expect(floating.style.transform).toBe("matrix(1, 0, 0, 1, 2, 3)");
  });

  it("does nothing when the editor DOM has no boundary ancestor", () => {
    const editorDom = document.createElement("div");
    const editor = { view: { dom: editorDom } };
    const floating = createFloatingElement(
      "lb-tiptap-floating-toolbar",
      rect(-10, -10, 20, 20),
      "matrix(1, 0, 0, 1, 2, 3)"
    );

    renderHook(() => useConstrainFloatingWithinEditor(editor as never));

    expect(floating.style.transform).toBe("matrix(1, 0, 0, 1, 2, 3)");
  });

  it("reacts only to relevant visible mutations and resumes after visibility returns", () => {
    const { boundary, editor } = createEditorBoundary(rect(0, 0, 100, 100));
    const getBoundaryRect = vi.mocked(boundary.getBoundingClientRect);
    const floating = createFloatingElement(
      "lb-tiptap-floating-toolbar",
      rect(20, 20, 20, 20),
      "matrix(1, 0, 0, 1, 0, 0)"
    );
    const irrelevant = document.createElement("span");
    renderHook(() => useConstrainFloatingWithinEditor(editor as never));
    const observer = TestMutationObserver.instances[0];
    expect(observer).toBeDefined();
    const initialCalls = getBoundaryRect.mock.calls.length;

    observer?.emit([mutation("childList", irrelevant)]);
    observer?.emit([mutation("attributes", floating, "class")]);
    expect(getBoundaryRect).toHaveBeenCalledTimes(initialCalls);

    observer?.emit([mutation("childList", floating)]);
    observer?.emit([mutation("attributes", floating, "style")]);
    expect(getBoundaryRect).toHaveBeenCalledTimes(initialCalls + 2);

    documentIsHidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    observer?.emit([mutation("childList", floating)]);
    expect(getBoundaryRect).toHaveBeenCalledTimes(initialCalls + 2);

    documentIsHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getBoundaryRect).toHaveBeenCalledTimes(initialCalls + 3);
  });

  it("debounces layout events and clears observers, listeners, and timers", () => {
    vi.useFakeTimers();
    const { boundary, editor } = createEditorBoundary(rect(0, 0, 100, 100));
    const getBoundaryRect = vi.mocked(boundary.getBoundingClientRect);
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    createFloatingElement(
      "lb-tiptap-floating-toolbar",
      rect(20, 20, 20, 20),
      "matrix(1, 0, 0, 1, 0, 0)"
    );
    const { unmount } = renderHook(() =>
      useConstrainFloatingWithinEditor(editor as never)
    );
    const observer = TestMutationObserver.instances[0];
    const initialCalls = getBoundaryRect.mock.calls.length;

    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(16);
    expect(getBoundaryRect).toHaveBeenCalledTimes(initialCalls + 1);

    window.dispatchEvent(new Event("scroll"));
    unmount();
    vi.runAllTimers();

    expect(getBoundaryRect).toHaveBeenCalledTimes(initialCalls + 1);
    expect(observer?.disconnect).toHaveBeenCalledOnce();
    expect(removeWindowListener).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
      true
    );
    expect(removeWindowListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function)
    );
    expect(removeDocumentListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function)
    );
  });
});

class TestMutationObserver {
  static instances: TestMutationObserver[] = [];
  private readonly callback: MutationCallback;
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();

  constructor(callback: MutationCallback) {
    this.callback = callback;
    TestMutationObserver.instances.push(this);
  }

  emit(records: MutationRecord[]) {
    this.callback(records, this as never);
  }
}

class TestDOMMatrixReadOnly {
  m41 = 0;
  m42 = 0;

  constructor(transform = "matrix(1, 0, 0, 1, 0, 0)") {
    if (transform === "invalid") {
      throw new Error("invalid matrix");
    }
    const values = transform.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    this.m41 = values.at(-2) ?? 0;
    this.m42 = values.at(-1) ?? 0;
  }
}

class TestDOMMatrix extends TestDOMMatrixReadOnly {
  static fromMatrix(matrix: TestDOMMatrixReadOnly) {
    const result = new TestDOMMatrix();
    result.m41 = matrix.m41;
    result.m42 = matrix.m42;
    return result;
  }

  toString() {
    return `matrix(1, 0, 0, 1, ${this.m41}, ${this.m42})`;
  }
}

function createEditorBoundary(boundaryRect: DOMRect) {
  const boundary = document.createElement("div");
  boundary.dataset.liveblocksEditorBoundary = "";
  boundary.getBoundingClientRect = vi.fn(() => boundaryRect);
  const editorDom = document.createElement("div");
  boundary.append(editorDom);
  document.body.append(boundary);
  return { boundary, editor: { view: { dom: editorDom } } };
}

function createFloatingElement(
  className: string,
  elementRect: DOMRect,
  transform: string,
  dataAttribute?: "floating-composer" | "floating-toolbar"
) {
  const element = document.createElement("div");
  element.className = className;
  if (dataAttribute) {
    element.setAttribute(`data-${dataAttribute}`, "");
  }
  element.getBoundingClientRect = vi.fn(() => elementRect);
  element.style.transform = transform;
  document.body.append(element);
  return element;
}

function mutation(
  type: MutationRecordType,
  target: Node,
  attributeName: string | null = null
): MutationRecord {
  const fragment = document.createDocumentFragment();
  if (type === "childList") {
    fragment.append(target.cloneNode(true));
  }
  const removedNodes = document.createDocumentFragment().childNodes;
  return {
    addedNodes: fragment.childNodes,
    attributeName,
    attributeNamespace: null,
    nextSibling: null,
    oldValue: null,
    previousSibling: null,
    removedNodes,
    target,
    type,
  };
}

function rect(left: number, top: number, width: number, height: number) {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
  } as DOMRect;
}
