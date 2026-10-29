import type { ApiKey } from "@repo/api/src/types/api-key";
import type { GoogleIntegrationStatus } from "@repo/api/src/types/google";
import type { PenseroCredentialInfoResponse } from "@repo/api/src/types/pensero-integration";
import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model";
import type { Meta, StoryObj } from "@storybook/react";
import { platformApiKeys } from "../../../api-keys/hooks/use-platform-api-keys";
import { googleKeys } from "../../../google/hooks/use-google-integration";
import { penseroIntegrationKeys } from "../../../pensero/hooks/use-pensero-integration";
import {
  GOOGLE_DRIVE_FEATURE_FLAG_KEY,
  PENSERO_INTEGRATION_FEATURE_FLAG_KEY,
} from "../../../shared/lib/feature-flags";
import { settingsViewModelKeys } from "../hooks/use-settings-view-model";
import { ApiKeysSettingsPanel } from "../panels/api-keys-settings-panel";
import { PluginsSettingsPanel } from "../panels/plugins-settings-panel";

/**
 * ISS-10316. The API Keys and Plugins panel bodies with the credential and
 * connection cards the legacy Integrations tab used to hold, over the REAL
 * hooks — each story only seeds the query cache.
 *
 * Lives in `components/` for the same reason as the governance stories:
 * Storybook's globs do not reach a story co-located beside a panel.
 */
const PLATFORM_KEY: ApiKey = {
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  expiresAt: null,
  id: "key-1",
  keyPrefix: "sk_live_",
  lastUsedAt: null,
  name: "CI pipeline",
  organizationId: "org-1",
  revokedAt: null,
  scopes: ["read", "write", "delete"],
  userId: "user-1",
};

const PENSERO_INFO: PenseroCredentialInfoResponse = {
  baseUrl: null,
  isSet: true,
  lastFour: "4321",
  setAt: "2026-08-03T00:00:00.000Z",
  teamIdentifiers: [],
};

const GOOGLE_STATUS: GoogleIntegrationStatus = {
  connected: false,
  email: null,
};

function viewModelFor(role: SettingsActorRole) {
  return projectSettingsViewModel({
    resolution: { role, status: SettingsActorRoleStatus.Resolved },
    staleSessionRole: false,
  });
}

function cacheFor(role: SettingsActorRole) {
  return [
    [settingsViewModelKeys.viewModel(), viewModelFor(role)],
    [platformApiKeys.lists(), [PLATFORM_KEY]],
    [penseroIntegrationKeys.info(), PENSERO_INFO],
    [googleKeys.status(), GOOGLE_STATUS],
  ] as const;
}

const meta: Meta<typeof ApiKeysSettingsPanel> = {
  component: ApiKeysSettingsPanel,
  parameters: {
    appCore: {
      enabledFlags: [
        PENSERO_INTEGRATION_FEATURE_FLAG_KEY,
        GOOGLE_DRIVE_FEATURE_FLAG_KEY,
      ],
      queryData: cacheFor(SettingsActorRole.Admin),
    },
    layout: "padded",
  },
  title: "Composites v1.0/Settings/Developer Settings Panels",
  tags: ["deprecated"],
};

export default meta;

type Story = StoryObj<typeof ApiKeysSettingsPanel>;

/** An org admin: platform keys, then the Pensero credential. */
export const ApiKeysAdmin: Story = {};

/**
 * A member: the Pensero form is not offered, because its write is admin-gated
 * on the server.
 */
export const ApiKeysMember: Story = {
  parameters: {
    appCore: {
      enabledFlags: [PENSERO_INTEGRATION_FEATURE_FLAG_KEY],
      queryData: cacheFor(SettingsActorRole.Member),
    },
  },
};

/** The Plugins panel with Google Drive not connected. */
export const PluginsWithGoogleDrive: Story = {
  render: () => <PluginsSettingsPanel />,
};
