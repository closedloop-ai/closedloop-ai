/**
 * FEA-4125 follow-up: `SidebarCollapsibleSection` must render its FIRST client
 * render from the SSR-stable `defaultOpen`, not from the persisted open state.
 * Reading `localStorage` in the `useState` initializer diverged the first client
 * render from the server-rendered HTML for a returning user who had collapsed a
 * section (server renders it open, client hydrates it closed), tripping React
 * hydration error #418 — which the authenticated route's error boundary caught
 * and blanked the whole page, since this section is shared sidebar chrome on
 * every authenticated surface. The component lives in `@repo/design-system`
 * (no test runner); it is exercised here where `@repo/app`'s vitest picks it up,
 * mirroring `sidebar-provider-ssr.test.tsx`. matchMedia is supplied globally by
 * `packages/app/vitest.setup.ts` (SidebarProvider's useIsMobile reads it).
 */

import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The chevron carries `-rotate-90` only when the section is collapsed, so its
// presence in the markup is a proxy for the rendered open/closed state.
const COLLAPSED_CHEVRON_CLASS = "-rotate-90";
const PERSIST_KEY = "test:sidebar-collapsible:open";

function labsSection() {
  return (
    <SidebarProvider>
      <SidebarCollapsibleSection
        defaultOpen
        persistenceKey={PERSIST_KEY}
        title="Labs"
      >
        <div>labs content</div>
      </SidebarCollapsibleSection>
    </SidebarProvider>
  );
}

describe("SidebarCollapsibleSection SSR/hydration safety (FEA-4125 follow-up)", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    globalThis.localStorage.clear();
  });

  it("hydrates SSR markup without a recoverable error when a differing collapsed state is persisted", async () => {
    // A returning user collapsed the section on a previous visit. The bug read
    // this "false" in the useState initializer, so the first client render
    // diverged from the server's default-open HTML → React #418, which the
    // route error boundary caught and blanked the page.
    globalThis.localStorage.setItem(PERSIST_KEY, "false");

    // Server render sees no persisted state (SSR has no localStorage): the
    // section is open. This is the exact HTML the client must reproduce on its
    // first render during hydration.
    const serverHtml = renderToString(labsSection());
    expect(serverHtml).not.toContain(COLLAPSED_CHEVRON_CLASS);

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    // A hydration mismatch surfaces to `onRecoverableError` (React error #418).
    // Asserting it never fires proves the SSR-to-client boundary stays intact —
    // renderToString alone (the prior version of this test) never reached
    // hydrateRoot, so a later server/client divergence could pass the test while
    // React still recovered a hydration mismatch in production.
    const recoverableErrors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    // biome-ignore lint/suspicious/useAwait: act's async form requires an async callback even when the body is sync.
    await act(async () => {
      root = hydrateRoot(container, labsSection(), {
        onRecoverableError: (error) => {
          recoverableErrors.push(error);
        },
      });
    });

    expect(recoverableErrors).toEqual([]);

    // After hydration + the post-mount effect, the persisted collapsed state
    // applies as a same-frame correction rather than a hydration mismatch.
    await waitFor(() =>
      expect(container.innerHTML).toContain(COLLAPSED_CHEVRON_CLASS)
    );

    // biome-ignore lint/suspicious/useAwait: act's async form requires an async callback even when the body is sync.
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it("applies the persisted collapsed state after mount", async () => {
    globalThis.localStorage.setItem(PERSIST_KEY, "false");

    const { container } = render(labsSection());

    // The post-mount effect restores the saved view one commit after hydration.
    await waitFor(() =>
      expect(container.innerHTML).toContain(COLLAPSED_CHEVRON_CLASS)
    );
  });
});
