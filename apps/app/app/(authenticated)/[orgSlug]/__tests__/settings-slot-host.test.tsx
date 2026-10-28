import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import { SettingsDismissMode } from "@repo/app/settings/v2/components/settings-dismissal";
import { SettingsShell } from "@repo/app/settings/v2/components/settings-shell";
import { createSettingsPanelRegistry } from "@repo/app/settings/v2/lib/settings-panel-registry";
import {
  fixturePanel,
  grantRead,
} from "@repo/app/settings/v2/test-fixtures/settings-panel-fixtures";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSlotHost } from "../settings-slot-host";
import { useSettingsSlotOverlay } from "../settings-slot-overlay";

const segments = vi.hoisted(() => ({
  childSegments: ["dashboard"] as readonly string[],
  slotSegment: "dashboard" as string | null,
}));

const location = vi.hoisted(() => ({
  pathname: "/acme/dashboard",
  search: "",
}));

const router = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/lib/navigation/next-adapter", () => ({
  useSettingsSlotSegments: () => ({
    childSegments: segments.childSegments,
    slotSegment: segments.slotSegment,
  }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => location.pathname,
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(location.search),
}));

const INTERCEPTED = "(.)settings";
const CHILDREN = <div data-testid="underlying-surface">dashboard</div>;
const SLOT = <div data-testid="settings-slot">settings</div>;

/** Reports whether the slot was handed an overlay, and lets a test dismiss it. */
function OverlayProbe() {
  const overlay = useSettingsSlotOverlay();
  return (
    <button
      data-overlay={overlay ? "overlay" : "none"}
      data-testid="settings-slot"
      onClick={() => overlay?.onDismiss()}
      type="button"
    >
      settings
    </button>
  );
}

/**
 * A surface holding local state: the counter must survive the overlay opening
 * and closing, which it cannot if the host relocates `children` in the tree.
 */
function StatefulSurface() {
  const [count, setCount] = useState(0);
  return (
    <button
      data-testid="underlying-surface"
      onClick={() => setCount((value) => value + 1)}
      type="button"
    >
      {count}
    </button>
  );
}

function host(slot: ReactNode, children: ReactNode = CHILDREN) {
  return <SettingsSlotHost slot={slot}>{children}</SettingsSlotHost>;
}

function activateIntercept(
  childSegments: readonly string[] = ["dashboard"]
): void {
  segments.slotSegment = INTERCEPTED;
  segments.childSegments = childSegments;
  location.pathname = "/acme/settings";
  location.search = "";
}

function deactivateIntercept(
  childSegments: readonly string[] = ["dashboard"]
): void {
  segments.slotSegment = childSegments[0] ?? null;
  segments.childSegments = childSegments;
  location.pathname = `/acme/${childSegments.join("/")}`;
  location.search = "";
}

/** ISS-8370 D2 — what the `@settings` slot means: overlay, cold, or inert. */
describe("SettingsSlotHost", () => {
  beforeEach(() => {
    segments.slotSegment = "dashboard";
    segments.childSegments = ["dashboard"];
    location.pathname = "/acme/dashboard";
    location.search = "";
    router.push.mockReset();
    router.replace.mockReset();
    router.back.mockReset();
  });

  it("renders only children while the slot is inactive", () => {
    render(host(SLOT));

    expect(screen.getByTestId("underlying-surface")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-slot")).not.toBeInTheDocument();
  });

  it("renders children AND the slot, as an overlay", () => {
    activateIntercept();

    render(host(<OverlayProbe />));

    expect(screen.getByTestId("underlying-surface")).toBeInTheDocument();
    expect(screen.getByTestId("settings-slot")).toHaveAttribute(
      "data-overlay",
      "overlay"
    );
  });

  it("keeps the surface mounted, state intact, across an overlay open and close", () => {
    const tree = () => host(<OverlayProbe />, <StatefulSurface />);
    const { rerender } = render(tree());
    fireEvent.click(screen.getByTestId("underlying-surface"));
    expect(screen.getByTestId("underlying-surface")).toHaveTextContent("1");

    activateIntercept();
    rerender(tree());
    expect(screen.getByTestId("settings-slot")).toHaveAttribute(
      "data-overlay",
      "overlay"
    );
    expect(screen.getByTestId("underlying-surface")).toHaveTextContent("1");

    deactivateIntercept();
    rerender(tree());
    expect(screen.queryByTestId("settings-slot")).not.toBeInTheDocument();
    expect(screen.getByTestId("underlying-surface")).toHaveTextContent("1");
  });

  it("renders the slot alone, cold, when children already are the Settings page", () => {
    // A soft navigation from a hard-loaded /settings to /settings?panel=x is
    // intercepted too; the page underneath keeps its stale params, so the slot
    // is the one that carries the request and nothing is behind it to overlay.
    activateIntercept(["settings"]);

    render(host(<OverlayProbe />));

    expect(screen.queryByTestId("underlying-surface")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-slot")).toHaveAttribute(
      "data-overlay",
      "none"
    );
  });

  it("overlays a retained Settings subroute instead of mistaking it for the Settings page", () => {
    // /settings/integrations/desktop/connect shares its first segment with
    // /settings. A first-segment match would take the cold branch here: drop the
    // connect screen, and send a dismiss to Dashboard instead of back.
    const subroute = [
      "settings",
      "integrations",
      "desktop",
      "connect",
    ] as const;
    deactivateIntercept(subroute);
    const { rerender } = render(host(<OverlayProbe />));

    activateIntercept(subroute);
    rerender(host(<OverlayProbe />));

    expect(screen.getByTestId("underlying-surface")).toBeInTheDocument();
    expect(screen.getByTestId("settings-slot")).toHaveAttribute(
      "data-overlay",
      "overlay"
    );

    fireEvent.click(screen.getByTestId("settings-slot"));

    expect(router.replace).toHaveBeenCalledWith(
      "/acme/settings/integrations/desktop/connect"
    );
  });

  it("dismisses an overlay by replacing the URL with the surface's own href, never a push", () => {
    location.pathname = "/acme/branches";
    location.search = "view=open";
    const { rerender } = render(host(<OverlayProbe />));

    activateIntercept(["branches"]);
    rerender(host(<OverlayProbe />));

    fireEvent.click(screen.getByTestId("settings-slot"));

    expect(router.replace).toHaveBeenCalledWith("/acme/branches?view=open");
    expect(router.push).not.toHaveBeenCalled();
  });

  /**
   * The keyboard case: Escape in overlay mode reaches the host's dismiss and
   * performs no navigation of its own, and once the slot is gone focus returns
   * to the control that was focused when the modal opened — the menu item that
   * navigated here.
   */
  it("returns focus to the invoking control after Escape dismisses the overlay", async () => {
    const registry = createSettingsPanelRegistry([fixturePanel("profile")]);
    function InterceptedShell() {
      const overlay = useSettingsSlotOverlay();
      return (
        <SettingsShell
          capabilities={grantRead("profile")}
          dismissal={
            overlay
              ? {
                  mode: SettingsDismissMode.Overlay,
                  onDismiss: overlay.onDismiss,
                }
              : { mode: SettingsDismissMode.Cold }
          }
          host={SettingsPanelHost.Web}
          registry={registry}
          routeParams={parseSettingsRouteParams({})}
        />
      );
    }
    const tree = () => (
      <>
        <button type="button">Settings</button>
        {host(<InterceptedShell />)}
      </>
    );
    // The dismiss lands on the router, which in production moves the slot back
    // to its inert catch-all; the mock does the same so the shell really unmounts.
    router.replace.mockImplementation(() => {
      segments.slotSegment = "dashboard";
      location.pathname = "/acme/dashboard";
    });
    const user = userEvent.setup();

    const { rerender } = render(tree());
    const invoker = screen.getByRole("button", { name: "Settings" });
    invoker.focus();

    activateIntercept();
    rerender(tree());
    expect(screen.getByTestId("settings-shell")).toBeInTheDocument();
    expect(document.activeElement).not.toBe(invoker);

    await user.keyboard("{Escape}");

    expect(router.replace).toHaveBeenCalledWith("/acme/dashboard");
    expect(router.push).not.toHaveBeenCalled();
    rerender(tree());
    await waitFor(
      () => {
        expect(screen.queryByTestId("settings-shell")).not.toBeInTheDocument();
        expect(document.activeElement).toBe(invoker);
      },
      { timeout: 3000 }
    );
  });
});
