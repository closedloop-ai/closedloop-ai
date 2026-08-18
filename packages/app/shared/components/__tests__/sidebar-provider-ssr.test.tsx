/**
 * FEA-3861 Slice 2: SidebarProvider must render SSR-pure (no `document`/`window`
 * access before mount) and its cookie write must be guarded so a non-DOM shell
 * (SSR, future RN adapter) never throws. `SidebarProvider` lives in
 * `@repo/design-system`, which has no test runner; it is exercised here where
 * `@repo/app`'s vitest picks it up.
 */

import {
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOGGLE_SIDEBAR_NAME = /toggle sidebar/i;

describe("SidebarProvider SSR purity (FEA-3861)", () => {
  beforeEach(() => {
    // jsdom lacks matchMedia; useIsMobile() reads it on the client path.
    globalThis.window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof globalThis.window.matchMedia;
  });

  it("server-renders without touching document or window before mount", () => {
    // renderToString exercises the server code path. A bare `document.cookie`
    // write during render (or an unguarded global read) would throw here.
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    // Simulate the server: no DOM globals during render.
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
    try {
      expect(() =>
        renderToString(
          <SidebarProvider defaultOpen>
            <div>content</div>
          </SidebarProvider>
        )
      ).not.toThrow();
    } finally {
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
    }
  });

  it("still persists the open state to a cookie when the DOM is present", async () => {
    const user = userEvent.setup();
    render(
      <SidebarProvider defaultOpen>
        <SidebarTrigger />
        <div>content</div>
      </SidebarProvider>
    );

    await user.click(screen.getByRole("button", { name: TOGGLE_SIDEBAR_NAME }));

    // The guarded write reaches document.cookie when the DOM is present.
    expect(document.cookie).toContain("sidebar_state=false");
  });
});
