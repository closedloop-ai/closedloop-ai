import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRedirectSearchParams } from "@/lib/app-route-redirects";
import SettingsRoutePage from "../page";
import {
  SettingsIntegrationCallbackParam,
  SettingsTab,
} from "../settings-tabs";

const { authMock, settingsPageMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  settingsPageMock: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  auth: authMock,
}));

vi.mock("../components/settings-page", () => ({
  SettingsPage: settingsPageMock,
}));

type Params = {
  tab?: string | string[];
  github?: string | string[];
  google?: string | string[];
  linear?: string | string[];
};

function renderPage(params: Params, isAdmin: boolean) {
  authMock.mockResolvedValue({
    has: ({ role }: { role: string }) =>
      isAdmin && (role === "org:admin" || role === "org:owner"),
  });
  return SettingsRoutePage({ searchParams: Promise.resolve(params) });
}

describe("Settings route page — initial tab resolution", () => {
  beforeEach(() => {
    authMock.mockReset();
    settingsPageMock.mockReset();
    settingsPageMock.mockImplementation(
      ({ initialTab }: { initialTab: string }) => (
        <div data-initial-tab={initialTab} data-testid="settings-page" />
      )
    );
  });

  it("falls back to Profile when a stale ?tab=admin deep link is requested (FEA-3975)", async () => {
    // The Admin tab was removed, so its old id is no longer allowlisted even
    // for an admin. A bookmarked ?tab=admin must degrade to the default tab
    // rather than open a tab that no longer renders.
    render(await renderPage({ tab: "admin" }, true));

    expect(settingsPageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialTab: SettingsTab.Profile,
        isAdmin: true,
      }),
      undefined
    );
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Profile
    );
  });

  it("honors a still-valid deep link (?tab=integrations)", async () => {
    render(await renderPage({ tab: SettingsTab.Integrations }, false));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Integrations
    );
  });

  it("keeps the admin-only custom-fields tab reachable for admins", async () => {
    render(await renderPage({ tab: SettingsTab.CustomFields }, true));
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.CustomFields
    );
  });

  it("hides the admin-only custom-fields deep link from members", async () => {
    render(await renderPage({ tab: SettingsTab.CustomFields }, false));
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Profile
    );
  });

  it("keeps the admin-only compliance tab reachable for admins (FEA-4029)", async () => {
    render(await renderPage({ tab: SettingsTab.Compliance }, true));
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Compliance
    );
  });

  it("hides the admin-only compliance deep link from members (FEA-4029)", async () => {
    render(await renderPage({ tab: SettingsTab.Compliance }, false));
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Profile
    );
  });

  it("forces the integrations tab on an OAuth callback regardless of ?tab", async () => {
    render(await renderPage({ tab: "admin", github: "connected" }, true));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Integrations
    );
  });

  it("ignores an empty callback param, which is no callback at all", async () => {
    render(
      await renderPage({ tab: SettingsTab.Organization, github: "" }, false)
    );

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Organization
    );
  });
});

/**
 * closedloop-ai-stage, PR #4501: a retired route's successor query is only half
 * a contract — this page is free to IGNORE the tab it is sent, dropping any tab
 * outside the caller's allowlist and falling back to Profile with nothing on
 * screen saying why. That coupling is executed here rather than left to review:
 * the ISS-5011 `/organization` forward's REAL query is driven through the REAL
 * destination page, so the day the Organization tab goes admin-only or behind a
 * flag, this fails instead of the forward silently recreating the broken promise
 * it exists to keep.
 */
describe("Settings route page — ISS-5011 /organization forward lands on its tab", () => {
  beforeEach(() => {
    authMock.mockReset();
    settingsPageMock.mockReset();
    settingsPageMock.mockImplementation(
      ({ initialTab }: { initialTab: string }) => (
        <div data-initial-tab={initialTab} data-testid="settings-page" />
      )
    );
  });

  it("honors the forward's tab for a plain member, not just an admin", async () => {
    const overlay = resolveRedirectSearchParams("/acme/organization", "acme");

    render(await renderPage({ tab: overlay?.set.tab }, false));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Organization
    );
  });

  // wongk, PR #4501: this is the state the proxy now prevents by stripping the
  // callback keys off the forward. Pinned from the destination's side so the
  // precedence that made stripping necessary cannot change unnoticed.
  it("still lets a real integration callback outrank an explicit ?tab", async () => {
    const overlay = resolveRedirectSearchParams("/acme/organization", "acme");

    render(
      await renderPage(
        {
          tab: overlay?.set.tab,
          [SettingsIntegrationCallbackParam.GitHub]: "bogus",
        },
        false
      )
    );

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Integrations
    );
    // ...which is exactly why the forward must clear those keys.
    expect(overlay?.remove).toContain(SettingsIntegrationCallbackParam.GitHub);
  });
});
