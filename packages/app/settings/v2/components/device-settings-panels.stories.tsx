import { BROWSER_SESSION_PAGE_LIMIT_MAX } from "@repo/api/src/types/browser-session";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  settingsLocalDeviceReady,
  settingsLocalSyncPolicyReady,
} from "@repo/api/src/types/settings-host-capabilities";
import {
  SettingsPanelHost,
  SettingsPanelIntent,
} from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import { computeTargetKeys } from "../../../compute/hooks/compute-target-query-keys";
import { browserSessionKeys } from "../../../devices/hooks/use-browser-sessions";
import { SettingsHostAdapterProvider } from "../../../shared/settings-host/provider";
import type { SettingsHostAdapter } from "../../../shared/settings-host/settings-host-adapter";
import { ConnectedDevicesPanel } from "../panels/connected-devices/connected-devices-panel";
import {
  buildBrowserSessionFixture,
  buildBrowserSessionListFixture,
  buildComputeTargetFixture,
} from "../test-fixtures/device-panel-fixtures";

/**
 * ISS-8366. The Connected Devices panel body as the shell mounts it, over the
 * REAL hooks — each story only seeds the query cache the harness already
 * provides, so what renders is the shipped derivation rather than a
 * hand-authored picture of it.
 *
 * Lives in `components/` because Storybook's globs reach two directory levels
 * under `packages/app` and no deeper (`apps/storybook/.storybook/main.ts`), so
 * a story co-located beside the panel would be collected by nothing and would
 * silently never run.
 */

// Must match `SESSION_PAGE_BOUNDS.limit` in browser-sessions-section.tsx
// exactly, not just be A page size: the query cache is keyed by this value,
// so a mismatch is a cache MISS, not a smaller page — and on a miss the
// harness's fixture transport falls back to an unmatched-GET default of `{}`,
// which crashes `sessions.data?.sessions.length` (`.data` exists, `.sessions`
// does not). Importing the same constant the component imports, rather than
// re-stating its value, keeps that impossible to drift apart again.
const PAGE_LIMIT = BROWSER_SESSION_PAGE_LIMIT_MAX;

const CURRENT_SESSION = buildBrowserSessionFixture({
  id: "sess_current",
  isCurrentSession: true,
});

const OTHER_SESSION = buildBrowserSessionFixture({
  activity: {
    browserName: "Safari",
    browserVersion: "19.2.1",
    country: "Ireland",
    deviceType: "iPhone",
    isMobile: true,
  },
  id: "sess_phone",
});

const UNDESCRIBED_SESSION = buildBrowserSessionFixture({
  activity: null,
  id: "sess_unknown",
});

const OWN_TARGET = buildComputeTargetFixture({
  id: "target-own",
  machineName: "Ada-MBP",
});

const SHARED_TARGET = buildComputeTargetFixture({
  id: "target-shared",
  isOnline: false,
  machineName: "Grace-MBP",
  ownerName: "Grace Hopper",
});

function cacheFor(
  page: ReturnType<typeof buildBrowserSessionListFixture>
): ReadonlyArray<readonly [readonly unknown[], unknown]> {
  return [
    [browserSessionKeys.list(PAGE_LIMIT, 0), page],
    // The shared target is seeded deliberately: the panel must withhold a
    // machine the viewer does not own, and a story that never supplies one
    // could not show that it does.
    [computeTargetKeys.list(), [OWN_TARGET, SHARED_TARGET]],
  ] as const;
}

const meta: Meta<typeof ConnectedDevicesPanel> = {
  component: ConnectedDevicesPanel,
  tags: ["deprecated", "autodocs"],
  parameters: {
    appCore: {
      queryData: cacheFor(
        buildBrowserSessionListFixture({
          sessions: [CURRENT_SESSION, OTHER_SESSION, UNDESCRIBED_SESSION],
        })
      ),
    },
    layout: "padded",
  },
  title: "Composites v1.0/Settings/Device Settings Panels",
};

export default meta;

type Story = StoryObj<typeof ConnectedDevicesPanel>;

/**
 * The whole page. The current row carries its marker and no Sign out; the row
 * the provider described nothing about renders explicit unknowns rather than
 * blanks beside real values.
 */
export const ConnectedDevices: Story = {};

/** More sessions exist than the page returned, and the panel says how many. */
export const TruncatedPage: Story = {
  parameters: {
    appCore: {
      queryData: cacheFor(
        buildBrowserSessionListFixture({
          sessions: [CURRENT_SESSION, OTHER_SESSION],
          totalCount: 11,
        })
      ),
    },
  },
};

/**
 * A total that cannot be reconciled with the page in hand. Distinct from the
 * complete page above on purpose: "this is everything" and "we could not tell"
 * are different claims, and collapsing them is the defect the three-member
 * completeness shape exists to prevent.
 */
export const UnknownPageExtent: Story = {
  parameters: {
    appCore: {
      queryData: cacheFor(
        buildBrowserSessionListFixture({
          sessions: [CURRENT_SESSION, OTHER_SESSION],
          totalCount: Number.MAX_SAFE_INTEGER + 2,
        })
      ),
    },
  },
};

/**
 * A caller whose transport has no browser session to identify — the Desktop
 * token. No row claims to be current, and the panel says why rather than
 * leaving the user to infer it.
 */
export const NoIdentifiableCurrentSession: Story = {
  parameters: {
    appCore: {
      queryData: cacheFor(
        buildBrowserSessionListFixture({
          currentSessionKnown: false,
          sessions: [CURRENT_SESSION, OTHER_SESSION],
        })
      ),
    },
  },
};

const desktopHostAdapter: SettingsHostAdapter = {
  host: SettingsPanelHost.Desktop,
  localSyncPolicy: {
    read: () =>
      Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Full)),
    write: (level) => Promise.resolve(settingsLocalSyncPolicyReady(level)),
  },
  readLocalDevice: () =>
    Promise.resolve(
      settingsLocalDeviceReady({
        appVersion: "0.15.115",
        computeTargetId: OWN_TARGET.id,
        gatewayPort: 4319,
        gatewayReachable: true,
        machineName: OWN_TARGET.machineName,
        platform: "darwin",
      })
    ),
};

/**
 * The same panel on a host that can answer for its own machine. The sync
 * selector exists here and nowhere else — the web adapter omits the capability
 * entirely, so its absence is structural rather than a hidden branch — and the
 * correlated row is marked as this device.
 */
export const OnDesktopWithSyncPolicy: Story = {
  render: () => (
    <SettingsHostAdapterProvider adapter={desktopHostAdapter}>
      <ConnectedDevicesPanel intent={SettingsPanelIntent.View} />
    </SettingsHostAdapterProvider>
  ),
};
