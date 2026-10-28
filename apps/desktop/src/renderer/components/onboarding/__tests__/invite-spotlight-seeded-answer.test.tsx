/**
 * ISS-12135 bug 50: a seeded profile's answer to the invite spotlight.
 *
 * A vibe renderer is served from a new origin on each launch, so its own
 * `localStorage` answer never survives one; the profile carries the seeded
 * organization's answer in its settings instead
 * (`DesktopSettings.inviteSpotlightAnsweredOrganizationIds`). These cases drive
 * the real provider over a stubbed bridge and read the open state it publishes.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import type { SyncConsentRecord } from "../../../../shared/sync-consent";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { resetDesktopIdentityCacheForTests } from "../../../shared-agent-sessions/use-desktop-identity";
import {
  InviteSpotlightProvider,
  useInviteSpotlight,
} from "../invite-spotlight";

const ORG_ID = "org_acme";
const OTHER_ORG_ID = "org_other";
const USER_ID = "user_1";

const CONSENTED: SyncConsentRecord = {
  bound: true,
  organizationId: ORG_ID,
  tier: "metadata",
};

vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: () => null,
}));

const bridge = {
  getDesktopAuthState: vi.fn(),
  getDesktopIdentity: vi.fn(),
  getSettings: vi.fn(),
  getSyncConsentRecord: vi.fn(),
  onDesktopAuthStateChanged: vi.fn(),
};

function stubBridge(readSettings: () => Promise<unknown>) {
  bridge.getDesktopAuthState = vi.fn(() =>
    Promise.resolve({
      organizationId: ORG_ID,
      status: DesktopAuthStatus.Authenticated,
      userId: USER_ID,
    })
  );
  bridge.getDesktopIdentity = vi.fn(() =>
    Promise.resolve({
      organizationName: "Acme Co",
      userName: "Jordan Avery",
      email: "jordan.avery@closedloop.ai",
    })
  );
  bridge.getSettings = vi.fn(readSettings);
  bridge.getSyncConsentRecord = vi.fn(() => Promise.resolve(CONSENTED));
  bridge.onDesktopAuthStateChanged = vi.fn(() => () => {
    // no-op unsubscribe
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: bridge,
    writable: true,
  });
}

function Consumer() {
  const spotlight = useInviteSpotlight();
  return <span data-testid="open">{String(spotlight.open)}</span>;
}

function renderProvider() {
  return render(
    <DesktopAppCoreProvider>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <SidebarProvider>
          <InviteSpotlightProvider>
            <Consumer />
          </InviteSpotlightProvider>
        </SidebarProvider>
      </FeatureFlagAdapterProvider>
    </DesktopAppCoreProvider>
  );
}

/** Every bridge read the decision waits on has been made and has settled. */
async function settleReads() {
  await waitFor(() => {
    expect(bridge.getSettings).toHaveBeenCalled();
    expect(bridge.getSyncConsentRecord).toHaveBeenCalled();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

beforeEach(() => {
  resetDesktopIdentityCacheForTests();
  stubLocalStorage();
});

afterEach(() => {
  Reflect.deleteProperty(window, "desktopApi");
  vi.clearAllMocks();
});

describe("invite spotlight — an answer the profile's settings carry", () => {
  it("stays closed for an organization the settings already answered", async () => {
    stubBridge(() =>
      Promise.resolve({ inviteSpotlightAnsweredOrganizationIds: [ORG_ID] })
    );

    renderProvider();
    await settleReads();

    expect(screen.getByTestId("open").textContent).toBe("false");
  });

  it("still opens when the settings answered a different organization", async () => {
    stubBridge(() =>
      Promise.resolve({
        inviteSpotlightAnsweredOrganizationIds: [OTHER_ORG_ID],
      })
    );

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("open").textContent).toBe("true")
    );
  });

  it("falls back to the renderer's own answer when the settings read fails", async () => {
    stubBridge(() => Promise.reject(new Error("bridge closed")));

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("open").textContent).toBe("true")
    );
  });
});
