import { PENSERO_INTEGRATION_PATH } from "@repo/api/src/types/pensero-integration";
import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../../../shared/feature-flags/provider";
import { PENSERO_INTEGRATION_FEATURE_FLAG_KEY } from "../../../../../shared/lib/feature-flags";
import { makeQueryClient } from "../../../../../shared/query/query-client";
import { SettingsHostAdapterProvider } from "../../../../../shared/settings-host/provider";
import {
  type SettingsHostAdapter,
  webSettingsHostAdapter,
} from "../../../../../shared/settings-host/settings-host-adapter";
import { ApiKeysCredentialCards } from "../api-keys-credential-cards";

const mockApiClient = { get: vi.fn() };

vi.mock("../../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const PENSERO_NOT_STORED = "No credential stored";

const RESPONSES: Record<string, unknown> = {
  "/settings/view-model": projectSettingsViewModel({
    resolution: {
      role: SettingsActorRole.Admin,
      status: SettingsActorRoleStatus.Resolved,
    },
    staleSessionRole: false,
  }),
  [PENSERO_INTEGRATION_PATH]: {
    baseUrl: null,
    isSet: false,
    lastFour: null,
    setAt: null,
    teamIdentifiers: [],
  },
};

const DESKTOP_HOST_ADAPTER: SettingsHostAdapter = {
  ...webSettingsHostAdapter,
  host: SettingsPanelHost.Desktop,
};

function renderCards(
  enabledFlags: readonly string[],
  hostAdapter: SettingsHostAdapter = webSettingsHostAdapter
) {
  const queryClient = makeQueryClient({ gcTime: 0 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SettingsHostAdapterProvider adapter={hostAdapter}>
      <FeatureFlagAdapterProvider
        adapter={{
          useFeatureFlagEnabled: (key: string) => enabledFlags.includes(key),
        }}
      >
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </FeatureFlagAdapterProvider>
    </SettingsHostAdapterProvider>
  );
  return render(<ApiKeysCredentialCards />, { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiClient.get.mockImplementation((path: string) =>
    path in RESPONSES
      ? Promise.resolve(RESPONSES[path])
      : Promise.reject(new Error(`unexpected GET ${path}`))
  );
});

describe("ApiKeysCredentialCards", () => {
  it("renders no Pensero card while the Pensero flag is off", () => {
    renderCards([]);

    expect(screen.queryByText(PENSERO_NOT_STORED)).not.toBeInTheDocument();
  });

  it("renders the Pensero card on the web host while the Pensero flag is on", async () => {
    renderCards([PENSERO_INTEGRATION_FEATURE_FLAG_KEY]);

    expect(await screen.findByText(PENSERO_NOT_STORED)).toBeInTheDocument();
  });

  it("renders the Pensero card on the desktop host while the Pensero flag is on", async () => {
    renderCards([PENSERO_INTEGRATION_FEATURE_FLAG_KEY], DESKTOP_HOST_ADAPTER);

    expect(await screen.findByText(PENSERO_NOT_STORED)).toBeInTheDocument();
  });
});
