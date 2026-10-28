import {
  SettingsActorCapabilityStatus,
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";

// The card is lazily imported so it stays out of the Settings entry bundle. Stub
// it here: these cases are about the flag gate and the descriptor, and the card
// has its own suite.
vi.mock("../organization-profile-card", () => ({
  OrganizationProfileCard: () => <div data-testid="profile-card" />,
}));

import { createSettingsPanelRegistry } from "../../../lib/settings-panel-registry";
import { resolveSettingsPanel } from "../../../lib/settings-panel-resolution";
import { fixturePanel } from "../../../test-fixtures/settings-panel-fixtures";
import { organizationGeneralPanel } from "../organization-general-panel";

const PANEL_ID = SettingsPanelId.OrganizationGeneral;
const SECTION_DESCRIPTION_COPY = /Manage the company profile/i;

// The registry a composition root builds: this panel plus one other, so
// `fallbackPanelId` has somewhere real to point.
const registry = createSettingsPanelRegistry([
  organizationGeneralPanel,
  fixturePanel(SettingsPanelId.Profile),
]);

function resolveWith(
  host: SettingsPanelHost,
  capabilities: Parameters<typeof resolveSettingsPanel>[0]["capabilities"]
) {
  return resolveSettingsPanel({
    capabilities,
    host,
    registry,
    requestedPanel: PANEL_ID,
  });
}

const READY_CAPABILITIES = {
  grants: { [PANEL_ID]: [SettingsPanelCapability.Read] },
  status: SettingsActorCapabilityStatus.Ready,
} as const;

// `SettingsShell` mounts every panel inside a Suspense boundary, which is what
// lets a panel body be lazy. Mirrored here so the lazy import can resolve.
function renderPanelBody() {
  const { Panel } = organizationGeneralPanel;

  render(
    <Suspense fallback={<span>loading panel</span>}>
      <Panel intent="view" />
    </Suspense>
  );
}

describe("organizationGeneralPanel descriptor", () => {
  it("claims the reserved OrganizationGeneral id without minting a new one", () => {
    expect(organizationGeneralPanel.id).toBe(PANEL_ID);
    expect(registry.has(PANEL_ID)).toBe(true);
  });

  it("is offered on web only, so the desktop shell can report unavailable rather than a denial", () => {
    expect(organizationGeneralPanel.hosts).toEqual([SettingsPanelHost.Web]);
  });

  it("requires only Read, matching SETTINGS_DOMAIN_ACCESS_POLICY granting every role read on the Organization domain", () => {
    expect(organizationGeneralPanel.requiredCapability).toBe(
      SettingsPanelCapability.Read
    );
  });
});

// The six outcomes are DISTINCT by contract (ISS-8362 AC1). Asserting them here,
// against a registry that really holds this panel, is what proves this
// descriptor participates correctly instead of collapsing two of them.
describe("six-state resolution for the Organization General panel", () => {
  it("resolves ready for a member on web", () => {
    const resolution = resolveWith(SettingsPanelHost.Web, READY_CAPABILITIES);

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Ready);
    expect(resolution.panelId).toBe(PANEL_ID);
  });

  it("resolves unavailable on desktop — not forbidden — even for a fully granted actor", () => {
    const resolution = resolveWith(
      SettingsPanelHost.Desktop,
      READY_CAPABILITIES
    );

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Unavailable);
    expect(resolution.panelId).toBeNull();
  });

  it("resolves pending while the capability read is still in flight", () => {
    const resolution = resolveWith(SettingsPanelHost.Web, {
      status: SettingsActorCapabilityStatus.Pending,
    });

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Pending);
    expect(resolution.panelId).toBeNull();
  });

  it("resolves capability-error — never forbidden — when the capability read failed", () => {
    const resolution = resolveWith(SettingsPanelHost.Web, {
      status: SettingsActorCapabilityStatus.Error,
    });

    expect(resolution.status).toBe(
      SettingsPanelResolutionStatus.CapabilityError
    );
    expect(resolution.panelId).toBeNull();
  });

  it("resolves capability-error when this panel alone was unreadable in an otherwise ready projection", () => {
    const resolution = resolveWith(SettingsPanelHost.Web, {
      grants: { [SettingsPanelId.Profile]: [SettingsPanelCapability.Read] },
      status: SettingsActorCapabilityStatus.Ready,
      unreadable: [PANEL_ID],
    });

    expect(resolution.status).toBe(
      SettingsPanelResolutionStatus.CapabilityError
    );
  });

  it("resolves forbidden when the read settled and granted nothing", () => {
    const resolution = resolveWith(SettingsPanelHost.Web, {
      grants: {},
      status: SettingsActorCapabilityStatus.Ready,
    });

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Forbidden);
    expect(resolution.panelId).toBeNull();
  });

  it("resolves unknown for a link that names no panel we have", () => {
    const resolution = resolveSettingsPanel({
      capabilities: READY_CAPABILITIES,
      host: SettingsPanelHost.Web,
      registry,
      requestedPanel: "organisation-general",
    });

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Unknown);
  });
});

/**
 * ISS-10244 retired `settings-v2-organization-panel`. The two cases that pinned
 * the closed arm and the key it swapped on are gone with the gate; what the body
 * owes now is that it renders the section and the card, with no provider mounted
 * at all.
 */
describe("panel body", () => {
  it("renders the General section and the profile card unconditionally", async () => {
    renderPanelBody();

    expect(
      await screen.findByRole("heading", { level: 2, name: "General" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("profile-card")).toBeInTheDocument();
    expect(screen.getByText(SECTION_DESCRIPTION_COPY)).toBeInTheDocument();
  });
});
