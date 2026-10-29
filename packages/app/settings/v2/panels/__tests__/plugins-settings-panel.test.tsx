import {
  GOOGLE_OAUTH_CALLBACK_MESSAGE_PARAM,
  GOOGLE_OAUTH_CALLBACK_PARAM,
  GoogleOAuthCallbackOutcome,
} from "@repo/api/src/types/integration-connect-routes";
import {
  SETTINGS_PANEL_PARAM,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../../shared/feature-flags/provider";
import { GOOGLE_DRIVE_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { PluginsSettingsPanel } from "../plugins-settings-panel";

const toastCalls: { kind: string; message: string }[] = [];

// The Google Drive card reads its own status endpoint and is covered in
// `plugins/__tests__`.
vi.mock("../plugins/google-drive-card", () => ({
  GoogleDriveCard: () => <div data-testid="google-drive-card" />,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

function renderPanel({
  initialPath = "/settings",
  enabledFlags = [],
}: {
  initialPath?: string;
  enabledFlags?: readonly string[];
} = {}) {
  const navigation = createMemoryNavigation({ initialPath });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={navigation.adapter}>
      <FeatureFlagAdapterProvider
        adapter={{
          useFeatureFlagEnabled: (key: string) => enabledFlags.includes(key),
        }}
      >
        {children}
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
  return render(<PluginsSettingsPanel />, { wrapper });
}

describe("PluginsSettingsPanel Google Drive", () => {
  const originalHref = globalThis.location.href;

  beforeEach(() => {
    vi.clearAllMocks();
    toastCalls.length = 0;
  });

  afterEach(() => {
    globalThis.history.replaceState(null, "", originalHref);
  });

  it("mounts the Google Drive card only when its flag is on", async () => {
    const flagged = renderPanel({
      enabledFlags: [GOOGLE_DRIVE_FEATURE_FLAG_KEY],
    });
    expect(await screen.findByTestId("google-drive-card")).toBeInTheDocument();
    flagged.unmount();

    renderPanel();
    // `render` flushes the flag gate's mount effect inside `act`, so the
    // absence below is read after the gate has decided.
    expect(screen.getByText("Plugins")).toBeInTheDocument();
    expect(screen.queryByTestId("google-drive-card")).not.toBeInTheDocument();
  });

  it.each([
    {
      query: `tab=integrations&${GOOGLE_OAUTH_CALLBACK_PARAM}=${GoogleOAuthCallbackOutcome.Success}`,
      toast: {
        kind: "success",
        message: "Google Drive connected successfully",
      },
    },
    {
      query: `tab=integrations&${GOOGLE_OAUTH_CALLBACK_PARAM}=${GoogleOAuthCallbackOutcome.Error}&${GOOGLE_OAUTH_CALLBACK_MESSAGE_PARAM}=x`,
      toast: { kind: "error", message: "Failed to connect Google Drive" },
    },
  ])(
    "reports ?$query once and rewrites the URL to the Plugins panel",
    async ({ query, toast }) => {
      const path = `/acme/settings?${query}`;
      globalThis.history.replaceState(null, "", path);

      renderPanel({ initialPath: path });

      await waitFor(() => expect(toastCalls).toEqual([toast]));
      const params = new URLSearchParams(globalThis.location.search);
      expect(params.has(GOOGLE_OAUTH_CALLBACK_PARAM)).toBe(false);
      expect(params.has(GOOGLE_OAUTH_CALLBACK_MESSAGE_PARAM)).toBe(false);
      expect(params.has("tab")).toBe(false);
      expect(params.get(SETTINGS_PANEL_PARAM)).toBe(SettingsPanelId.Plugins);
      expect(globalThis.location.pathname).toBe("/acme/settings");
    }
  );
});
