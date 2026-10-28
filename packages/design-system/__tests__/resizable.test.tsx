import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@closedloop-ai/design-system/components/ui/resizable";
import { legacyLayoutStorageKey } from "@closedloop-ai/design-system/components/ui/resizable-layout-storage";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * react-resizable-panels@3 → @4 renamed the components, renamed `direction`,
 * and removed `autoSaveId`. Only the renames fail typecheck; losing the saved
 * layout changes what a user sees with no compile error at all, so this pins
 * that a layout written by v3 still loads, and that a vertical group still
 * carries the `data-panel-group-direction` attribute the handle's CSS reads
 * (v3 emitted it; v4 does not).
 *
 * jsdom has no layout, so the library cannot resolve `defaultSize` and falls
 * back to an equal share for every panel — which is why "not restored" reads as
 * 50/50 below. The numeric-percentage contract is pinned at the prop boundary
 * instead, in `resizable-panel-size.test.tsx`.
 */

const AUTO_SAVE_ID = "document-editor";
const BODY_ID = "document-editor-body";
const CHAT_ID = "document-editor-chat";
const PANEL_IDS = [BODY_ID, CHAT_ID];
const EQUAL_SHARE = 50;
const FLEX_GROW_PATTERN = /flex:\s*([\d.]+)/;

/** `flex: <grow> 1 0px` — the share of the group this panel occupies. */
function flexGrowOf(panelId: string): number {
  const style = screen.getByTestId(panelId).getAttribute("style") ?? "";
  const match = FLEX_GROW_PATTERN.exec(style);
  return match ? Number(match[1]) : Number.NaN;
}

function storeLegacyLayout(entries: Record<string, number[]>) {
  globalThis.localStorage.setItem(
    legacyLayoutStorageKey(AUTO_SAVE_ID),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(entries).map(([panelKey, layout]) => [
          panelKey,
          { expandToSizes: {}, layout },
        ])
      )
    )
  );
}

function renderDocumentEditorGroup() {
  return render(
    <ResizablePanelGroup
      autoSaveId={AUTO_SAVE_ID}
      direction="horizontal"
      panelIds={PANEL_IDS}
    >
      <ResizablePanel defaultSize={75} id={BODY_ID} minSize={50}>
        body
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={25} id={CHAT_ID} maxSize={40} minSize={15}>
        chat
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

afterEach(() => {
  globalThis.localStorage.clear();
});

describe("ResizablePanelGroup persisted layout", () => {
  it("restores a layout saved by react-resizable-panels@3", () => {
    storeLegacyLayout({
      '{"defaultSize":75,"minSize":50},{"maxSize":40,"minSize":15}': [62, 38],
    });

    renderDocumentEditorGroup();

    expect(flexGrowOf(BODY_ID)).toBe(62);
    expect(flexGrowOf(CHAT_ID)).toBe(38);
  });

  it("restores a layout already written in the v4 shape", () => {
    globalThis.localStorage.setItem(
      `react-resizable-panels:${AUTO_SAVE_ID}:${PANEL_IDS.join(":")}`,
      JSON.stringify({ [BODY_ID]: 58, [CHAT_ID]: 42 })
    );

    renderDocumentEditorGroup();

    expect(flexGrowOf(BODY_ID)).toBe(58);
    expect(flexGrowOf(CHAT_ID)).toBe(42);
  });

  it("ignores a saved layout written for a different set of panels", () => {
    storeLegacyLayout({ '{"minSize":50}': [100] });

    renderDocumentEditorGroup();

    expect(flexGrowOf(BODY_ID)).toBe(EQUAL_SHARE);
    expect(flexGrowOf(CHAT_ID)).toBe(EQUAL_SHARE);
  });

  it("renders with no saved layout at all", () => {
    renderDocumentEditorGroup();

    expect(flexGrowOf(BODY_ID)).toBe(EQUAL_SHARE);
    expect(flexGrowOf(CHAT_ID)).toBe(EQUAL_SHARE);
  });
});

describe("ResizableHandle orientation", () => {
  it.each([["vertical"], ["horizontal"]] as const)(
    "carries %s so the direction-scoped handle styles can apply",
    (direction) => {
      render(
        <ResizablePanelGroup direction={direction}>
          <ResizablePanel id={BODY_ID}>body</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id={CHAT_ID}>chat</ResizablePanel>
        </ResizablePanelGroup>
      );

      expect(screen.getByRole("separator")).toHaveAttribute(
        "data-panel-group-direction",
        direction
      );
    }
  );
});
