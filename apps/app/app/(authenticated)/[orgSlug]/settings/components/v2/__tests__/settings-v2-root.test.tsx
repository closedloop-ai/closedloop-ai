import {
  type SettingsActorCapabilities,
  SettingsActorCapabilityStatus,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import { SettingsDismissMode } from "@repo/app/settings/v2/components/settings-dismissal";
import { grantRead } from "@repo/app/settings/v2/test-fixtures/settings-panel-fixtures";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RumErrorSource } from "@/lib/datadog-rum/error-source";
import { SettingsV2Root } from "../settings-v2-root";

const shell = vi.hoisted(() => ({
  capabilities: {
    status: "pending",
  } as SettingsActorCapabilities,
  retry: vi.fn(),
}));

const profileBody = vi.hoisted(() => ({ throwOnRender: false }));

const reportNextjsErrorMock = vi.hoisted(() => vi.fn());

const router = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/settings",
  useRouter: () => ({ push: vi.fn(), replace: router.replace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@repo/app/settings/v2/hooks/use-settings-view-model", () => ({
  useSettingsShellCapabilities: () => ({
    capabilities: shell.capabilities,
    retry: shell.retry,
  }),
}));

vi.mock("@/lib/datadog-rum/report-error", () => ({
  reportNextjsError: reportNextjsErrorMock,
}));

// The Profile body is Clerk-backed; what this suite exercises is the ROOT’s
// wiring around it (the boundary and the reporter), so the body is a stub that
// can be told to throw.
vi.mock("../profile/profile-settings-panel-body", () => ({
  ProfileSettingsPanelBody: () => {
    if (profileBody.throwOnRender) {
      throw new Error("profile exploded");
    }
    return <div data-testid="profile-body">profile</div>;
  },
}));

const COLD = { mode: SettingsDismissMode.Cold } as const;

function renderRoot(search: Record<string, string> = {}): void {
  render(
    <SettingsV2Root
      dismissal={COLD}
      routeParams={parseSettingsRouteParams(search)}
    />
  );
}

function panelState(): string | null {
  return (
    document
      .querySelector("[data-settings-panel-state]")
      ?.getAttribute("data-settings-panel-state") ?? null
  );
}

function navLinkNames(): string[] {
  return screen
    .getAllByRole("link")
    .map((link) => link.textContent?.trim() ?? "")
    .filter((name) => name.length > 0 && !name.startsWith("Open "));
}

/**
 * ISS-8370 M1 — the web composition root. No feature-flag provider is mounted,
 * so the one surviving leaf key (`artifact-tags`) resolves CLOSED and Tags stays
 * unregistered; the ownership assert at module scope has already run by the time
 * the import above resolves.
 *
 * ISS-10244 retired the developer, device and organization panel gates, so the
 * panels they used to withhold are registered here unconditionally.
 */
describe("SettingsV2Root", () => {
  beforeEach(() => {
    shell.capabilities = grantRead(...Object.values(SettingsPanelId));
    shell.retry.mockReset();
    reportNextjsErrorMock.mockReset();
    profileBody.throwOnRender = false;
    router.replace.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.history.replaceState(null, "", "/");
  });

  it("replaces a legacy Integrations link to the Anthropic card with its API Keys link", async () => {
    globalThis.history.replaceState(
      null,
      "",
      "/acme/settings?tab=integrations#anthropic-api-key"
    );

    renderRoot({ tab: "integrations" });

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        "/acme/settings?panel=api-keys#anthropic-api-key"
      )
    );
  });

  it("does not redirect a legacy Integrations link without the card fragment", async () => {
    globalThis.history.replaceState(
      null,
      "",
      "/acme/settings?tab=integrations"
    );

    renderRoot({ tab: "integrations" });

    expect(await screen.findAllByRole("link")).not.toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("renders the User and Organization panels, Tags withheld, with the tags capability closed", () => {
    renderRoot({ panel: SettingsPanelId.Tags });

    // Connected Devices and Plugins join the nav that ISS-10244 un-gated. The
    // order is the CONTRACT navigation order (`SETTINGS_PANEL_IDS`), never
    // registration order. The Labs settings group does not render in this tree,
    // so its ids — Tags among them — stay absent either way; the deep-link case
    // below is what pins Tags itself being unregistered.
    expect(navLinkNames()).toEqual([
      "Profile",
      "Connected Devices",
      "Plugins",
      "General",
      "Members",
    ]);
  });

  it("resolves a deep link to a closed-flag panel as unknown, offering Profile", () => {
    renderRoot({ panel: SettingsPanelId.Tags });

    expect(panelState()).toBe("unknown");
    expect(screen.getByRole("link", { name: "Open Profile" })).toHaveAttribute(
      "href",
      "/acme/settings?panel=profile"
    );
  });

  it("mounts the default panel body on a plain visit", async () => {
    renderRoot();

    expect(await screen.findByTestId("profile-body")).toBeInTheDocument();
  });

  it("shows the pending screen while the capability read is in flight", () => {
    shell.capabilities = { status: SettingsActorCapabilityStatus.Pending };

    renderRoot();

    expect(panelState()).toBe("loading");
    expect(screen.queryByTestId("profile-body")).not.toBeInTheDocument();
  });

  it("offers a retry that refetches when the capability read failed", () => {
    shell.capabilities = { status: SettingsActorCapabilityStatus.Error };

    renderRoot();

    expect(panelState()).toBe("capability-error");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(shell.retry).toHaveBeenCalledTimes(1);
  });

  it("routes a crashed panel to the root error boundary's reporter (D9)", async () => {
    profileBody.throwOnRender = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderRoot();

    await waitFor(() => {
      expect(panelState()).toBe("render-error");
    });
    expect(reportNextjsErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "profile exploded" }),
      { source: RumErrorSource.NextjsErrorBoundary }
    );
  });
});
