import { GitHubDiffSide } from "@repo/api/src/types/branch-view";
import { describe, expect, test, vi } from "vitest";
import {
  clampRangeToContiguous,
  collectRenderedLineNumbers,
  findRenderedRightLineRow,
  findScrollAreaViewport,
  getCenteredRowScrollTop,
  getRenderedSplitRowHighlightIds,
  hasRenderedDiffRows,
  parseRenderedDiffLineAnchor,
  scrollRowIntoDiffViewport,
} from "../branch-diff-target";

function buildSplitViewTable(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <div data-slot="scroll-area-viewport">
      <table>
        <tbody>
          <tr data-testid="left-only">
            <td><pre>42</pre></td>
            <td><pre>- old</pre></td>
            <td class="left"><pre>old</pre></td>
            <td><pre>41</pre></td>
            <td><pre></pre></td>
            <td class="right"><pre>new</pre></td>
          </tr>
          <tr data-testid="right-code-cell-only">
            <td><pre>40</pre></td>
            <td><pre></pre></td>
            <td class="left"><pre>old</pre></td>
            <td><pre>41</pre></td>
            <td><pre></pre></td>
            <td class="right"><pre>42</pre></td>
          </tr>
          <tr data-testid="right-target">
            <td><pre>41</pre></td>
            <td><pre></pre></td>
            <td class="left"><pre>old</pre></td>
            <td><pre>42</pre></td>
            <td><pre>+</pre></td>
            <td class="right"><pre>new target</pre></td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
  return root;
}

function buildAddedOnlySplitViewTable(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <table>
      <tbody>
        <tr data-testid="added-only">
          <td><pre></pre></td>
          <td><pre></pre></td>
          <td class="left"><pre></pre></td>
          <td><pre>42</pre></td>
          <td><pre>+</pre></td>
          <td class="right"><pre>new target</pre></td>
        </tr>
      </tbody>
    </table>
  `;
  return root;
}

function buildDeletedOnlySplitViewTable(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <table>
      <tbody>
        <tr data-testid="deleted-only">
          <td><pre>42</pre></td>
          <td><pre>-</pre></td>
          <td class="left"><pre>old target</pre></td>
          <td><pre></pre></td>
          <td><pre></pre></td>
          <td class="right"><pre></pre></td>
        </tr>
      </tbody>
    </table>
  `;
  return root;
}

function setBoxMetrics(
  element: HTMLElement,
  metrics: {
    clientHeight: number;
    rect: Pick<DOMRect, "bottom" | "height" | "top">;
    scrollHeight?: number;
  }
): void {
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  if (metrics.scrollHeight !== undefined) {
    Object.defineProperty(element, "scrollHeight", {
      configurable: true,
      value: metrics.scrollHeight,
    });
  }
  element.getBoundingClientRect = () =>
    ({
      bottom: metrics.rect.bottom,
      height: metrics.rect.height,
      left: 0,
      right: 800,
      top: metrics.rect.top,
      width: 800,
      x: 0,
      y: metrics.rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("branch diff target helpers", () => {
  test("parses rendered split-view line ids into GitHub diff anchors", () => {
    expect(parseRenderedDiffLineAnchor("R-42")).toEqual({
      line: 42,
      side: GitHubDiffSide.Right,
    });
    expect(parseRenderedDiffLineAnchor("L-7")).toEqual({
      line: 7,
      side: GitHubDiffSide.Left,
    });
    expect(parseRenderedDiffLineAnchor("X-7")).toBeNull();
    expect(parseRenderedDiffLineAnchor("R-abc")).toBeNull();
  });

  test("finds the row when the right gutter cell matches the target line", () => {
    const root = buildSplitViewTable();
    expect(findRenderedRightLineRow(root, 42)?.dataset.testid).toBe(
      "right-target"
    );
  });

  test("ignores right-side code cells whose text equals the target line", () => {
    const root = buildSplitViewTable();
    expect(findRenderedRightLineRow(root, 42)?.dataset.testid).not.toBe(
      "right-code-cell-only"
    );
  });

  test("ignores a line that appears only in the left gutter", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <table>
        <tbody>
          <tr>
            <td><pre>42</pre></td>
            <td><pre>- removed</pre></td>
            <td class="left"><pre>removed</pre></td>
            <td><pre></pre></td>
            <td><pre></pre></td>
            <td class="right"><pre></pre></td>
          </tr>
        </tbody>
      </table>
    `;

    expect(findRenderedRightLineRow(root, 42)).toBeNull();
  });

  test("builds row-wide split-view highlight ids for the rendered target row", () => {
    const root = buildSplitViewTable();
    const row = findRenderedRightLineRow(root, 42);
    expect(row).not.toBeNull();
    if (!row) {
      return;
    }

    expect(getRenderedSplitRowHighlightIds(row)).toEqual(["L-41", "R-42"]);
  });

  test("omits the empty side highlight id for an added-only split-view row", () => {
    const root = buildAddedOnlySplitViewTable();
    const row = findRenderedRightLineRow(root, 42);
    expect(row).not.toBeNull();
    if (!row) {
      return;
    }

    expect(getRenderedSplitRowHighlightIds(row)).toEqual(["R-42"]);
  });

  test("omits the empty side highlight id for a deleted-only split-view row", () => {
    const root = buildDeletedOnlySplitViewTable();
    const row = root.querySelector<HTMLTableRowElement>("tr");
    expect(row).not.toBeNull();
    if (!row) {
      return;
    }

    expect(getRenderedSplitRowHighlightIds(row)).toEqual(["L-42"]);
  });

  test("finds the ScrollArea viewport", () => {
    const root = buildSplitViewTable();
    expect(findScrollAreaViewport(root)).toHaveAttribute(
      "data-slot",
      "scroll-area-viewport"
    );
  });

  test("reports whether diff rows have been inserted", () => {
    const root = buildSplitViewTable();
    expect(hasRenderedDiffRows(root)).toBe(true);

    const emptyRoot = document.createElement("div");
    emptyRoot.innerHTML = "<table><tbody></tbody></table>";
    expect(hasRenderedDiffRows(emptyRoot)).toBe(false);
  });

  test("computes the viewport scrollTop that centers the target row", () => {
    const viewport = document.createElement("div");
    const row = document.createElement("tr");
    viewport.scrollTop = 300;
    setBoxMetrics(viewport, {
      clientHeight: 400,
      rect: { bottom: 500, height: 400, top: 100 },
    });
    setBoxMetrics(row, {
      clientHeight: 20,
      rect: { bottom: 850, height: 20, top: 830 },
    });

    expect(getCenteredRowScrollTop(viewport, row)).toBe(840);
  });

  test("scrolls the diff viewport directly instead of depending on row scrollIntoView", () => {
    const root = buildSplitViewTable();
    const viewport = findScrollAreaViewport(root);
    const row = findRenderedRightLineRow(root, 42);
    const scrollTo = vi.fn(function scrollTo(
      this: HTMLElement,
      options?: ScrollToOptions
    ) {
      this.scrollTop = Number(options?.top ?? 0);
    });
    expect(viewport).not.toBeNull();
    expect(row).not.toBeNull();
    if (!(viewport && row)) {
      return;
    }

    setBoxMetrics(viewport, {
      clientHeight: 400,
      rect: { bottom: 500, height: 400, top: 100 },
      scrollHeight: 1200,
    });
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    setBoxMetrics(row, {
      clientHeight: 20,
      rect: { bottom: 850, height: 20, top: 830 },
    });

    expect(scrollRowIntoDiffViewport(root, row)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 540 });
  });

  test("skips a non-scrollable ScrollArea viewport and scrolls the effective ancestor", () => {
    const outer = document.createElement("div");
    const root = buildSplitViewTable();
    outer.append(root);
    const viewport = findScrollAreaViewport(root);
    const row = findRenderedRightLineRow(root, 42);
    const viewportScrollTo = vi.fn(function scrollTo(
      this: HTMLElement,
      options?: ScrollToOptions
    ) {
      this.scrollTop = Number(options?.top ?? 0);
    });
    const outerScrollTo = vi.fn(function scrollTo(
      this: HTMLElement,
      options?: ScrollToOptions
    ) {
      this.scrollTop = Number(options?.top ?? 0);
    });
    expect(viewport).not.toBeNull();
    expect(row).not.toBeNull();
    if (!(viewport && row)) {
      return;
    }

    setBoxMetrics(viewport, {
      clientHeight: 900,
      rect: { bottom: 1000, height: 900, top: 100 },
      scrollHeight: 900,
    });
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: viewportScrollTo,
    });
    setBoxMetrics(outer, {
      clientHeight: 400,
      rect: { bottom: 500, height: 400, top: 100 },
      scrollHeight: 1200,
    });
    Object.defineProperty(outer, "scrollTo", {
      configurable: true,
      value: outerScrollTo,
    });
    setBoxMetrics(row, {
      clientHeight: 20,
      rect: { bottom: 850, height: 20, top: 830 },
    });

    expect(scrollRowIntoDiffViewport(root, row)).toBe(true);
    expect(viewportScrollTo).not.toHaveBeenCalled();
    expect(outerScrollTo).toHaveBeenCalledWith({ top: 540 });
  });

  test("falls through when a scrollable-looking viewport does not actually move", () => {
    const outer = document.createElement("div");
    const root = buildSplitViewTable();
    outer.append(root);
    const viewport = findScrollAreaViewport(root);
    const row = findRenderedRightLineRow(root, 42);
    const viewportScrollTo = vi.fn();
    const outerScrollTo = vi.fn(function scrollTo(
      this: HTMLElement,
      options?: ScrollToOptions
    ) {
      this.scrollTop = Number(options?.top ?? 0);
    });
    expect(viewport).not.toBeNull();
    expect(row).not.toBeNull();
    if (!(viewport && row)) {
      return;
    }

    setBoxMetrics(viewport, {
      clientHeight: 400,
      rect: { bottom: 500, height: 400, top: 100 },
      scrollHeight: 1200,
    });
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: viewportScrollTo,
    });
    setBoxMetrics(outer, {
      clientHeight: 400,
      rect: { bottom: 500, height: 400, top: 100 },
      scrollHeight: 1200,
    });
    Object.defineProperty(outer, "scrollTo", {
      configurable: true,
      value: outerScrollTo,
    });
    setBoxMetrics(row, {
      clientHeight: 20,
      rect: { bottom: 850, height: 20, top: 830 },
    });

    expect(scrollRowIntoDiffViewport(root, row)).toBe(true);
    expect(viewportScrollTo).toHaveBeenCalledWith({ top: 540 });
    expect(outerScrollTo).toHaveBeenCalledWith({ top: 540 });
  });

  test("returns false when no effective scroll container can move the row", () => {
    const root = buildSplitViewTable();
    const viewport = findScrollAreaViewport(root);
    const row = findRenderedRightLineRow(root, 42);
    expect(viewport).not.toBeNull();
    expect(row).not.toBeNull();
    if (!(viewport && row)) {
      return;
    }

    setBoxMetrics(viewport, {
      clientHeight: 900,
      rect: { bottom: 1000, height: 900, top: 100 },
      scrollHeight: 900,
    });
    setBoxMetrics(row, {
      clientHeight: 20,
      rect: { bottom: 850, height: 20, top: 830 },
    });

    expect(scrollRowIntoDiffViewport(root, row)).toBe(false);
  });
});

describe("contiguous range clamping", () => {
  test("collects rendered line numbers per side from the split-view table", () => {
    const root = buildSplitViewTable();

    expect(
      [...collectRenderedLineNumbers(root, GitHubDiffSide.Right)].sort(
        (a, b) => a - b
      )
    ).toEqual([41, 42]);
    expect(
      [...collectRenderedLineNumbers(root, GitHubDiffSide.Left)].sort(
        (a, b) => a - b
      )
    ).toEqual([40, 41, 42]);
  });

  test("keeps a range that stays within one contiguous hunk", () => {
    const rendered = new Set([206, 207, 208, 209, 210, 211, 212]);
    expect(clampRangeToContiguous(rendered, 206, 212)).toEqual({
      endLine: 212,
      startLine: 206,
    });
  });

  test("caps the range at the fold when the target is in another hunk", () => {
    // 206..212 are rendered; 257 is in a separate hunk past the fold.
    const rendered = new Set([206, 207, 208, 209, 210, 211, 212, 257, 258]);
    expect(clampRangeToContiguous(rendered, 206, 257)).toEqual({
      endLine: 212,
      startLine: 206,
    });
  });

  test("caps an upward range at the fold below the pivot", () => {
    const rendered = new Set([100, 257, 258, 259, 260]);
    expect(clampRangeToContiguous(rendered, 260, 100)).toEqual({
      endLine: 260,
      startLine: 257,
    });
  });

  test("falls back to the raw range when the pivot is not rendered", () => {
    expect(clampRangeToContiguous(new Set<number>(), 206, 257)).toEqual({
      endLine: 257,
      startLine: 206,
    });
  });
});
