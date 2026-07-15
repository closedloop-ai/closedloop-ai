import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { Label } from "@closedloop-ai/design-system/components/ui/label";
import { Section } from "@closedloop-ai/design-system/components/ui/layout/section";
import { Switch } from "@closedloop-ai/design-system/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@closedloop-ai/design-system/components/ui/tabs";
import { Pencil, Trash2 } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { CLI_BINARY_TOOLS } from "../../../shared/cli-binary-tools";
import { ConnectionSecurityMode } from "../../../shared/connection-security";
import { FEATURE_FLAGS } from "../../../shared/feature-flags";
import {
  type CloudSyncStatusTone,
  describeCloudSyncStatus,
  parseCloudSync,
} from "../../hooks/use-ingest-progress";
import { DesktopAccountTab } from "./desktop-account-tab";

// FEA-2733: map a cloud-sync status tone to the Connection Status cell color,
// reusing the same CSS custom properties as the sibling status cells.
const CLOUD_SYNC_TONE_CLASS: Record<CloudSyncStatusTone, string> = {
  pending: "text-[var(--warning)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  muted: "text-[var(--muted-foreground)]",
};

type SettingsTab =
  | "account"
  | "relay-gateway"
  | "security"
  | "binary-paths"
  | "labs";

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "relay-gateway", label: "Relay / Gateway" },
  { id: "security", label: "Security" },
  { id: "binary-paths", label: "CLI Tools" },
  { id: "labs", label: "Labs" },
];

function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_TABS.some((item) => item.id === value);
}

/** Renderer view of ApiKeyStore.getStatus() (src/main/api-key-store.ts). */
type ApiKeyStatusView = {
  hasApiKey: boolean;
  source: "safeStorage" | "environment" | "none";
  environmentVariable?: string;
  provenance?: string;
};

type GatewayProfile = {
  id: string;
  name: string;
  relayOrigin: string;
  apiOrigin: string;
  webAppOrigin: string;
  hasCloudApiKey?: boolean;
  apiKeySource?: string;
};

type GatewayProfileFormState = {
  name: string;
  relayOrigin: string;
  apiOrigin: string;
  webAppOrigin: string;
  apiKey: string;
};

function getProfileFormState(
  profile: Partial<GatewayProfile> | null | undefined,
  settings: Record<string, unknown> | null
): GatewayProfileFormState {
  return {
    name: profile?.name ?? "",
    relayOrigin:
      profile?.relayOrigin ?? ((settings?.relayOrigin as string) || ""),
    apiOrigin: profile?.apiOrigin ?? ((settings?.apiOrigin as string) || ""),
    webAppOrigin:
      profile?.webAppOrigin ?? ((settings?.webAppOrigin as string) || ""),
    apiKey: "",
  };
}

function isProfileFormComplete(form: GatewayProfileFormState): boolean {
  return (
    form.name.trim().length > 0 &&
    form.relayOrigin.trim().length > 0 &&
    form.apiOrigin.trim().length > 0 &&
    form.webAppOrigin.trim().length > 0
  );
}

export function SettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>("relay-gateway");
  const [settings, setSettings] = useState<Record<string, unknown> | null>(
    null
  );
  // Once the user (or a deep-link) picks a tab, stop auto-selecting a default so
  // settings finishing loading never yanks them off their choice.
  const tabChosenRef = useRef(false);

  useEffect(() => {
    window.desktopApi
      .getSettings()
      .then((s) => {
        const record = s as Record<string, unknown>;
        setSettings(record);
        // Default to the first visible tab. Account (when its flag is enabled) is
        // first, but its flag lives in the settings we just loaded — so it can
        // only be selected here, not in the initial useState.
        if (
          !tabChosenRef.current &&
          record.desktopFirstPartyAuthEnabled === true
        ) {
          setTab("account");
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handler = (e: CustomEvent<string>) => {
      if (isSettingsTab(e.detail)) {
        tabChosenRef.current = true;
        setTab(e.detail);
      }
    };
    window.addEventListener(
      "desktop:navigate-settings-tab",
      handler as EventListener
    );
    return () =>
      window.removeEventListener(
        "desktop:navigate-settings-tab",
        handler as EventListener
      );
  }, []);

  // First-party desktop sign-in (FEA-2219) ships dark behind a desktop flag;
  // read it off the settings record the panel already loads (same pattern as
  // LabsTab), so the Account tab stays hidden until the flag is enabled.
  const accountEnabled = settings?.desktopFirstPartyAuthEnabled === true;
  const visibleTabs = accountEnabled
    ? SETTINGS_TABS
    : SETTINGS_TABS.filter((t) => t.id !== "account");

  return (
    <div className="space-y-4 p-6">
      <h2 className="font-semibold text-[var(--foreground)] text-lg">
        Settings
      </h2>

      <Tabs
        onValueChange={(value) => {
          if (isSettingsTab(value)) {
            tabChosenRef.current = true;
            setTab(value);
          }
        }}
        value={tab}
      >
        <TabsList>
          {visibleTabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {accountEnabled && (
          <TabsContent value="account">
            <DesktopAccountTab />
          </TabsContent>
        )}
        <TabsContent value="relay-gateway">
          <RelayGatewayTab onSettingsChange={setSettings} settings={settings} />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab settings={settings} />
        </TabsContent>
        <TabsContent value="binary-paths">
          <BinaryPathsTab />
        </TabsContent>
        <TabsContent value="labs">
          <LabsTab
            active={tab === "labs"}
            onSettingsChange={setSettings}
            settings={settings}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RelayGatewayTab({
  settings,
  onSettingsChange,
}: {
  settings: Record<string, unknown> | null;
  onSettingsChange?: (s: Record<string, unknown>) => void;
}) {
  const [runtime, setRuntime] = useState<Record<string, unknown> | null>(null);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(true);
  const [hooksEnabled, setHooksEnabled] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hooksError, setHooksError] = useState<string | null>(null);
  // FEA-2733: local→cloud sync progress for the History Sync cell, derived from
  // the same `runtime` snapshot this tab already fetches for the other
  // Connection Status cells — no extra getRuntimeStatus poll.
  const cloudSyncStatus = describeCloudSyncStatus(parseCloudSync(runtime));

  useEffect(() => {
    window.desktopApi
      .getRuntimeStatus()
      .then((r) => setRuntime(r as Record<string, unknown>))
      .catch(() => {});
    window.desktopApi
      .getCloudCommandsPaused()
      .then((p) => setPaused(p as boolean))
      .catch(() => {});
    window.desktopApi
      .getCloudConnectionEnabled()
      .then((c) => setConnected(c as boolean))
      .catch(() => {});
    window.desktopApi
      .getAgentMonitorHooksEnabled()
      .then((h) => setHooksEnabled(h as boolean))
      .catch(() => {});
  }, []);

  const handlePauseToggle = async (next: boolean) => {
    setPauseError(null);
    try {
      await window.desktopApi.setCloudCommandsPaused(next);
      setPaused(next);
    } catch (err) {
      setPauseError(
        err instanceof Error ? err.message : "Failed to update pause setting"
      );
    }
  };

  const handleConnectionToggle = async (next: boolean) => {
    setConnectionError(null);
    try {
      await window.desktopApi.setCloudConnectionEnabled(next);
      setConnected(next);
    } catch (err) {
      setConnectionError(
        err instanceof Error ? err.message : "Failed to update cloud connection"
      );
    }
  };

  const handleHooksToggle = async (next: boolean) => {
    setHooksError(null);
    try {
      const result = await window.desktopApi.setAgentMonitorHooksEnabled(next);
      setHooksEnabled(result.enabled);
    } catch (err) {
      setHooksError(
        err instanceof Error ? err.message : "Failed to update session tracking"
      );
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <Section
        description="A live snapshot of the gateway port, cloud link, remote-command state, and security mode. Check here to confirm the desktop is reachable when remote sessions won't connect."
        title="Connection Status"
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <p className="text-[var(--muted-foreground)] text-xs">
              Gateway Port
            </p>
            <p className="font-semibold text-sm">
              {(runtime?.port as string) ?? "..."}
            </p>
          </div>
          <div>
            <p className="text-[var(--muted-foreground)] text-xs">
              Cloud Connection
            </p>
            <p
              className={`font-semibold text-sm ${connected ? "text-[var(--success)]" : "text-[var(--destructive)]"}`}
            >
              {connected ? "Connected" : "Disconnected"}
            </p>
          </div>
          <div>
            <p className="text-[var(--muted-foreground)] text-xs">
              Remote Commands
            </p>
            <p
              className={`font-semibold text-sm ${paused ? "text-[var(--warning)]" : "text-[var(--success)]"}`}
            >
              {paused ? "Paused" : "Active"}
            </p>
          </div>
          <div>
            <p className="text-[var(--muted-foreground)] text-xs">Security</p>
            <p className="font-semibold text-sm">
              {(runtime?.security as string) ?? "..."}
            </p>
          </div>
          <div>
            <p className="text-[var(--muted-foreground)] text-xs">
              History Sync
            </p>
            <p
              className={`font-semibold text-sm ${CLOUD_SYNC_TONE_CLASS[cloudSyncStatus.tone]}`}
              title={cloudSyncStatus.detail}
            >
              {cloudSyncStatus.label}
            </p>
          </div>
        </div>
      </Section>

      <Section
        contentClassName="space-y-3"
        description="The relay and API endpoints this desktop uses to reach the cloud. Change these only when pointing at a different environment, such as switching between a local and a hosted relay."
        title="Configuration"
      >
        <ConfigRow
          label="Compute Target"
          mono
          value={runtime?.targetId as string}
        />
        <ConfigRow
          label="Relay Origin"
          mono
          value={settings?.relayOrigin as string}
        />
        <ConfigRow
          label="API Origin"
          mono
          value={settings?.apiOrigin as string}
        />
      </Section>

      <GatewayProfilesCard
        onSettingsChange={onSettingsChange}
        settings={settings}
      />

      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">Pause Incoming Commands</p>
              <p className="text-[var(--muted-foreground)] text-xs">
                Pause processing of remote commands
              </p>
            </div>
            <Switch
              aria-label="Pause Incoming Commands"
              checked={paused}
              onCheckedChange={handlePauseToggle}
            />
          </div>
          {pauseError && (
            <p className="mt-1 text-[var(--destructive)] text-xs">
              {pauseError}
            </p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">Cloud Connection</p>
              <p className="text-[var(--muted-foreground)] text-xs">
                Enable cloud relay connection
              </p>
            </div>
            <Switch
              aria-label="Cloud Connection"
              checked={connected}
              onCheckedChange={handleConnectionToggle}
            />
          </div>
          {connectionError && (
            <p className="mt-1 text-[var(--destructive)] text-xs">
              {connectionError}
            </p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">
                Claude Code Session Tracking
              </p>
              <p className="text-[var(--muted-foreground)] text-xs">
                Receive live session events from Claude Code
              </p>
            </div>
            <Switch
              aria-label="Claude Code Session Tracking"
              checked={hooksEnabled}
              onCheckedChange={handleHooksToggle}
            />
          </div>
          {hooksError && (
            <p className="mt-1 text-[var(--destructive)] text-xs">
              {hooksError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SecurityTab({
  settings,
}: {
  settings: Record<string, unknown> | null;
}) {
  const [dangerousAutoApprove, setDangerousAutoApprove] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatusView | null>(
    null
  );
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [dangerousError, setDangerousError] = useState<string | null>(null);

  const refreshApiKeyStatus = useCallback(async () => {
    const status = await window.desktopApi.getApiKeyStatus();
    setApiKeyStatus(status as ApiKeyStatusView);
  }, []);

  useEffect(() => {
    window.desktopApi
      .getDangerousAutoApprove()
      .then(setDangerousAutoApprove)
      .catch(() => {});
    refreshApiKeyStatus().catch(() => {});
  }, [refreshApiKeyStatus]);

  const handleDangerousToggle = async (next: boolean) => {
    setDangerousError(null);
    try {
      await window.desktopApi.setDangerousAutoApprove(next);
      setDangerousAutoApprove(next);
    } catch (err) {
      setDangerousError(
        err instanceof Error
          ? err.message
          : "Failed to update auto-approve setting"
      );
    }
  };

  const handleSetApiKey = async () => {
    const value = apiKeyInput.trim();
    if (!value) {
      return;
    }
    setApiKeyBusy(true);
    setApiKeyError(null);
    try {
      await window.desktopApi.setApiKey(value);
      setApiKeyInput("");
      await refreshApiKeyStatus();
    } catch (err) {
      setApiKeyError(
        err instanceof Error ? err.message : "Failed to set API key"
      );
    } finally {
      setApiKeyBusy(false);
    }
  };

  const handleClearApiKey = async () => {
    setApiKeyBusy(true);
    setApiKeyError(null);
    try {
      await window.desktopApi.clearApiKey();
      setApiKeyInput("");
      await refreshApiKeyStatus();
    } catch (err) {
      setApiKeyError(
        err instanceof Error ? err.message : "Failed to clear API key"
      );
    } finally {
      setApiKeyBusy(false);
    }
  };

  const apiKeyConfigured = apiKeyStatus?.hasApiKey === true;
  const apiKeyFromEnv = apiKeyStatus?.source === "environment";
  const apiKeyValueLabel = apiKeyStatus
    ? apiKeyConfigured
      ? `Configured (${apiKeyStatus.source}${apiKeyStatus.provenance ? `, ${apiKeyStatus.provenance}` : ""})`
      : "Not configured"
    : "...";

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Security Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConfigRow label="API Key" value={apiKeyValueLabel} />
          <ConfigRow
            label="Auth Mode"
            value={(settings?.authMode as string) ?? "standard"}
          />

          <div className="space-y-2 border-t pt-2">
            <p className="font-medium text-sm">Manage API Key</p>
            <p className="text-[var(--muted-foreground)] text-xs">
              {apiKeyFromEnv
                ? "An API key is provided via an environment variable. Setting one here stores an encrypted key that takes precedence."
                : "Set a Closedloop API key (starts with sk_live_). It is stored encrypted at rest."}
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="API key"
                autoComplete="off"
                className="flex-1 font-mono text-xs"
                onChange={(e) => setApiKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSetApiKey().catch(() => {});
                  }
                }}
                placeholder="sk_live_..."
                type="password"
                value={apiKeyInput}
              />
              <Button
                disabled={apiKeyBusy || apiKeyInput.trim().length === 0}
                onClick={handleSetApiKey}
                size="sm"
                variant="outline"
              >
                Set
              </Button>
              <Button
                className="text-[var(--destructive)]"
                disabled={apiKeyBusy || !apiKeyConfigured}
                onClick={handleClearApiKey}
                size="sm"
                variant="ghost"
              >
                Clear
              </Button>
            </div>
            {apiKeyError && (
              <p className="text-[var(--destructive)] text-xs">{apiKeyError}</p>
            )}
          </div>

          <div className="border-t pt-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-[var(--destructive)] text-sm">
                  Dangerous Auto-Approve
                </p>
                <p className="text-[var(--muted-foreground)] text-xs">
                  Automatically approve all commands — use with extreme caution
                </p>
              </div>
              <Switch
                aria-label="Dangerous Auto-Approve"
                checked={dangerousAutoApprove}
                className="data-[state=checked]:bg-[var(--destructive)]"
                onCheckedChange={handleDangerousToggle}
              />
            </div>
            {dangerousError && (
              <p className="mt-1 text-[var(--destructive)] text-xs">
                {dangerousError}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BinaryPathsTab() {
  const [binaries, setBinaries] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    window.desktopApi
      .getBinaryPaths()
      .then((b) => {
        setBinaries(b as Record<string, string>);
        setLoading(false);
      })
      .catch(() => {
        // IPC rejected: leave binaries empty but stop showing the loading
        // placeholder so the tab does not hang on "Detecting tools...".
        setLoading(false);
      });
  }, []);

  const handleDetect = async () => {
    setLoading(true);
    try {
      await window.desktopApi.detectCliTools();
      const b = await window.desktopApi.getBinaryPaths();
      setBinaries(b as Record<string, string>);
    } catch {
      // IPC rejected: leave binaries as-is but stop showing the loading
      // placeholder so the tab does not hang on "Detecting tools...".
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (tool: string) => {
    setEditing(tool);
    setEditValue(binaries[tool] ?? "");
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditError(null);
  };

  const handleSave = async (tool: string) => {
    if (editValue) {
      try {
        await window.desktopApi.patchBinaryPaths({ [tool]: editValue });
        const b = await window.desktopApi.getBinaryPaths();
        setBinaries(b as Record<string, string>);
      } catch (err) {
        setEditError(
          err instanceof Error ? err.message : "Failed to save binary path"
        );
        return;
      }
    }
    setEditing(null);
    setEditError(null);
  };

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>CLI Tools</CardTitle>
            <Button
              disabled={loading}
              onClick={handleDetect}
              size="sm"
              variant="outline"
            >
              Detect Tools
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
              Detecting tools...
            </p>
          ) : (
            CLI_BINARY_TOOLS.map((tool) => (
              <div
                className="flex items-center justify-between rounded border p-3"
                key={tool}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{tool}</p>
                  {editing === tool ? (
                    <>
                      <Input
                        aria-label={tool}
                        autoFocus
                        className="mt-1 w-full font-mono text-xs"
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleSave(tool).catch(() => {});
                          }
                          if (e.key === "Escape") {
                            cancelEdit();
                          }
                        }}
                        placeholder={`/usr/bin/${tool}`}
                        type="text"
                        value={editValue}
                      />
                      {editError && (
                        <p className="mt-1 text-[var(--destructive)] text-xs">
                          {editError}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="max-w-[300px] truncate font-mono text-[var(--muted-foreground)] text-xs">
                      {binaries[tool] ?? "Not found"}
                    </p>
                  )}
                </div>
                <div className="ml-2 flex shrink-0 gap-2">
                  {editing === tool ? (
                    <>
                      <Button
                        onClick={() => handleSave(tool)}
                        size="sm"
                        variant="outline"
                      >
                        Save
                      </Button>
                      <Button onClick={cancelEdit} size="sm" variant="ghost">
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      onClick={() => startEdit(tool)}
                      size="sm"
                      variant="outline"
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// The Labs panel is driven directly by the shared feature-flag registry
// (single source of truth). `hiddenFromLabs` flags — e.g. shared kebab-case UI
// flags that are not user-set — are excluded so only user-facing toggles render.
const LAB_FLAGS = FEATURE_FLAGS.filter((flag) => !flag.hiddenFromLabs);

function LabsTab({
  active,
  settings,
  onSettingsChange,
}: {
  active: boolean;
  settings: Record<string, unknown> | null;
  onSettingsChange: (s: Record<string, unknown>) => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);

  const handleToggle = async (key: string, currentValue: boolean) => {
    setSaving(key);
    try {
      await window.desktopApi.updateSettings({ [key]: !currentValue });
      const updated = await window.desktopApi.getSettings();
      onSettingsChange(updated as Record<string, unknown>);
    } catch {
      /* ignore */
    }
    setSaving(null);
  };

  return (
    <div className="mt-4 space-y-4">
      <GatewayHealthCard active={active} />
      <Card>
        <CardHeader>
          <CardTitle>Labs</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-[var(--muted-foreground)] text-sm">
            Early access to experimental features and advanced controls.
          </p>
          <div className="space-y-3">
            {LAB_FLAGS.map((flag) => {
              const value = settings?.[flag.key] === true;
              return (
                <div
                  className="flex items-center justify-between rounded border p-3"
                  key={flag.key}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm">{flag.label}</p>
                      <Badge className="text-[10px]" variant="outline">
                        {flag.category}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[var(--muted-foreground)] text-xs">
                      {flag.description}
                    </p>
                    {flag.requiresRestart && (
                      <p className="mt-0.5 text-[10px] text-[var(--warning-foreground)]">
                        Requires restart
                      </p>
                    )}
                  </div>
                  <Switch
                    aria-label={`Toggle ${flag.label}`}
                    checked={value}
                    className="ml-3 shrink-0"
                    disabled={saving === flag.key}
                    onCheckedChange={() => handleToggle(flag.key, value)}
                  />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function GatewayHealthCard({ active }: { active: boolean }) {
  const [runtimeStatus, setRuntimeStatus] =
    useState<GatewayRuntimeStatus | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    let canceled = false;
    window.desktopApi
      .getRuntimeStatus()
      .then((status) => {
        if (!canceled) {
          setRuntimeStatus(parseGatewayRuntimeStatus(status));
        }
      })
      .catch(() => {
        if (!canceled) {
          setRuntimeStatus(null);
        }
      });
    return () => {
      canceled = true;
    };
  }, [active]);

  const health = getGatewayHealthStatus(runtimeStatus);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gateway Health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${health.dotClassName}`}
          />
          <span className={`font-semibold text-sm ${health.textClassName}`}>
            {health.label}
          </span>
        </div>
        <div className="space-y-2">
          <ConfigRow
            label="Gateway Port"
            mono
            value={formatRuntimeStatusValue(runtimeStatus?.port)}
          />
          <ConfigRow
            label="Security"
            value={formatConnectionSecurityValue(
              runtimeStatus?.connectionSecurity
            )}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function GatewayProfilesCard({
  settings,
  onSettingsChange,
}: {
  settings: Record<string, unknown> | null;
  onSettingsChange?: (s: Record<string, unknown>) => void;
}) {
  const savedConfigs = (settings?.savedConfigs as GatewayProfile[]) ?? [];
  const activeConfigId = settings?.activeConfigId as string | null | undefined;
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    activeConfigId ?? null
  );
  const selectedProfile =
    savedConfigs.find((config) => config.id === selectedProfileId) ?? null;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [newProfileForm, setNewProfileForm] = useState<GatewayProfileFormState>(
    () => getProfileFormState(null, settings)
  );
  const [selectedForm, setSelectedForm] = useState<GatewayProfileFormState>(
    () => getProfileFormState(selectedProfile, settings)
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [applyError, setApplyError] = useState<ProfileActionError>(null);
  const [deleteError, setDeleteError] = useState<ProfileActionError>(null);

  const refreshSettings = async () => {
    const updated = await window.desktopApi.getSettings();
    onSettingsChange?.(updated as Record<string, unknown>);
  };

  useEffect(() => {
    if (savedConfigs.length === 0) {
      setSelectedProfileId(null);
      return;
    }
    if (
      selectedProfileId &&
      savedConfigs.some((config) => config.id === selectedProfileId)
    ) {
      return;
    }
    setSelectedProfileId(activeConfigId ?? savedConfigs[0]?.id ?? null);
  }, [activeConfigId, savedConfigs, selectedProfileId]);

  useEffect(() => {
    setSelectedForm(getProfileFormState(selectedProfile, settings));
    setProfileSaveError(null);
  }, [selectedProfile, settings]);

  const handleApplyProfile = async (id: string) => {
    setSelectedProfileId(id);
    setApplying(id);
    setApplyError(null);
    try {
      await window.desktopApi.applyConfig(id);
      await refreshSettings();
    } catch (err) {
      setApplyError({
        id,
        message: err instanceof Error ? err.message : "Failed to apply profile",
      });
    } finally {
      setApplying(null);
    }
  };

  const handleOpenDialog = () => {
    setNewProfileForm(getProfileFormState(null, settings));
    setSaveError(null);
    setDialogOpen(true);
  };

  const startRename = (id: string, currentName: string) => {
    setRenaming(id);
    setRenameValue(currentName);
    setRenameError(null);
  };

  const cancelRename = () => {
    setRenaming(null);
    setRenameValue("");
    setRenameError(null);
  };

  const handleRename = async (id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError("Name is required");
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await window.desktopApi.renameConfig(id, trimmed);
      await refreshSettings();
      setRenaming(null);
      setRenameValue("");
    } catch (err) {
      setRenameError(
        err instanceof Error ? err.message : "Failed to rename profile"
      );
    } finally {
      setRenameBusy(false);
    }
  };

  const handleDeleteConfirm = async (id: string) => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await window.desktopApi.deleteConfig(id);
      await refreshSettings();
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError({
        id,
        message:
          err instanceof Error ? err.message : "Failed to delete profile",
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!isProfileFormComplete(newProfileForm)) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const payload: {
        name: string;
        relayOrigin: string;
        apiOrigin: string;
        webAppOrigin: string;
        apiKey?: string;
      } = {
        name: newProfileForm.name,
        relayOrigin: newProfileForm.relayOrigin,
        apiOrigin: newProfileForm.apiOrigin,
        webAppOrigin: newProfileForm.webAppOrigin,
      };
      const apiKey = newProfileForm.apiKey.trim();
      if (apiKey) {
        payload.apiKey = apiKey;
      }
      const saved = (await window.desktopApi.saveConfig(payload)) as {
        id?: string;
      };
      await refreshSettings();
      if (saved.id) {
        setSelectedProfileId(saved.id);
      }
      setDialogOpen(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save profile"
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSelectedProfile = async () => {
    if (!(selectedProfile && isProfileFormComplete(selectedForm))) {
      return;
    }
    setProfileSaving(true);
    setProfileSaveError(null);
    try {
      const payload: {
        id: string;
        name: string;
        relayOrigin: string;
        apiOrigin: string;
        webAppOrigin: string;
        apiKey?: string;
      } = {
        id: selectedProfile.id,
        name: selectedForm.name,
        relayOrigin: selectedForm.relayOrigin,
        apiOrigin: selectedForm.apiOrigin,
        webAppOrigin: selectedForm.webAppOrigin,
      };
      const apiKey = selectedForm.apiKey.trim();
      if (apiKey) {
        payload.apiKey = apiKey;
      }
      await window.desktopApi.saveConfig(payload);
      await refreshSettings();
      setSelectedForm((current) => ({ ...current, apiKey: "" }));
    } catch (err) {
      setProfileSaveError(
        err instanceof Error ? err.message : "Failed to save profile"
      );
    } finally {
      setProfileSaving(false);
    }
  };

  return (
    <>
      <Section
        actions={
          <Button onClick={handleOpenDialog} size="sm" variant="outline">
            Save Profile
          </Button>
        }
        description="Saved sets of relay, API, and token settings you can switch between. Add a profile when you regularly move between environments so you can apply a whole configuration at once."
        title="Gateway Profiles"
      >
        {savedConfigs.length === 0 ? (
          <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
            No gateway profiles saved
          </p>
        ) : (
          <div className="space-y-2">
            {savedConfigs.map((config) => (
              <GatewayProfileRow
                applyError={
                  applyError?.id === config.id ? applyError.message : null
                }
                applying={applying === config.id}
                confirmingDelete={confirmDeleteId === config.id}
                deleteError={
                  deleteError?.id === config.id ? deleteError.message : null
                }
                deleting={deleting}
                isActive={config.id === activeConfigId}
                isRenaming={renaming === config.id}
                isSelected={config.id === selectedProfileId}
                key={config.id}
                onApply={() => {
                  handleApplyProfile(config.id).catch(() => {});
                }}
                onCancelDelete={() => {
                  setConfirmDeleteId(null);
                  setDeleteError(null);
                }}
                onCancelRename={cancelRename}
                onConfirmDelete={() => {
                  handleDeleteConfirm(config.id).catch(() => {});
                }}
                onRename={() => {
                  handleRename(config.id).catch(() => {});
                }}
                onRenameValueChange={(v) => {
                  setRenameValue(v);
                  setRenameError(null);
                }}
                onSelect={() => {
                  setSelectedProfileId(config.id);
                }}
                onStartDelete={() => {
                  setConfirmDeleteId(config.id);
                  setDeleteError(null);
                }}
                onStartRename={() => startRename(config.id, config.name)}
                profile={config}
                renameBusy={renameBusy}
                renameError={renameError}
                renameValue={renameValue}
              />
            ))}
          </div>
        )}
        {selectedProfile && (
          <div className="mt-4 space-y-3 border-t pt-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-sm">Selected Profile</p>
                <p className="truncate text-[var(--muted-foreground)] text-xs">
                  {selectedProfile.name}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {selectedProfile.hasCloudApiKey && (
                  <Badge className="text-[10px]" variant="outline">
                    Token saved
                  </Badge>
                )}
                {selectedProfile.id === activeConfigId && (
                  <Badge className="text-[10px]" variant="default">
                    Active
                  </Badge>
                )}
              </div>
            </div>
            <ProfileConnectionFields
              form={selectedForm}
              onChange={(patch) => {
                setSelectedForm((current) => ({ ...current, ...patch }));
                setProfileSaveError(null);
              }}
              tokenPlaceholder={
                selectedProfile.hasCloudApiKey
                  ? "Leave blank to keep saved token"
                  : "sk_live_..."
              }
            />
            {profileSaveError && (
              <p className="text-[var(--destructive)] text-xs">
                {profileSaveError}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                disabled={profileSaving || !isProfileFormComplete(selectedForm)}
                onClick={() => {
                  handleSaveSelectedProfile().catch(() => {});
                }}
                size="sm"
                variant="default"
              >
                {profileSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Current Configuration as Profile</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-[var(--muted-foreground)] text-sm">
              Enter a name and connection settings for this gateway profile.
            </p>
            <ProfileConnectionFields
              autoFocusName
              form={newProfileForm}
              onChange={(patch) => {
                setNewProfileForm((current) => ({ ...current, ...patch }));
                setSaveError(null);
              }}
              onEnter={() => {
                if (!saving) {
                  handleSaveProfile().catch(() => {});
                }
              }}
              tokenPlaceholder="sk_live_..."
            />
            {saveError && (
              <p className="text-[var(--destructive)] text-xs">{saveError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={saving}
              onClick={() => setDialogOpen(false)}
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={saving || !isProfileFormComplete(newProfileForm)}
              onClick={() => {
                handleSaveProfile().catch(() => {});
              }}
              variant="default"
            >
              {saving ? "Saving..." : "Save Profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProfileConnectionFields({
  form,
  onChange,
  onEnter,
  tokenPlaceholder,
  autoFocusName,
}: {
  form: GatewayProfileFormState;
  onChange: (patch: Partial<GatewayProfileFormState>) => void;
  onEnter?: () => void;
  tokenPlaceholder: string;
  autoFocusName?: boolean;
}) {
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      onEnter?.();
    }
  };
  const fieldIdPrefix = useId();
  const profileNameId = `${fieldIdPrefix}-name`;
  const authenticationTokenId = `${fieldIdPrefix}-authentication-token`;
  const relayUriId = `${fieldIdPrefix}-relay-uri`;
  const apiUriId = `${fieldIdPrefix}-api-uri`;
  const appUriId = `${fieldIdPrefix}-app-uri`;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={profileNameId}>
          Profile Name
        </Label>
        <Input
          autoFocus={autoFocusName}
          id={profileNameId}
          onChange={(e) => onChange({ name: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Production"
          type="text"
          value={form.name}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={authenticationTokenId}>
          Authentication Token
        </Label>
        <Input
          autoComplete="off"
          className="font-mono text-xs"
          id={authenticationTokenId}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder={tokenPlaceholder}
          type="password"
          value={form.apiKey}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={relayUriId}>
          Relay URI
        </Label>
        <Input
          className="font-mono text-xs"
          id={relayUriId}
          onChange={(e) => onChange({ relayOrigin: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="https://relay.closedloop.ai"
          type="text"
          value={form.relayOrigin}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={apiUriId}>
          API URI
        </Label>
        <Input
          className="font-mono text-xs"
          id={apiUriId}
          onChange={(e) => onChange({ apiOrigin: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="https://api.closedloop.ai"
          type="text"
          value={form.apiOrigin}
        />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label className="text-xs" htmlFor={appUriId}>
          App URI
        </Label>
        <Input
          className="font-mono text-xs"
          id={appUriId}
          onChange={(e) => onChange({ webAppOrigin: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="https://app.closedloop.ai"
          type="text"
          value={form.webAppOrigin}
        />
      </div>
    </div>
  );
}

type ProfileActionError = { id: string; message: string } | null;

type GatewayProfileRowProps = {
  profile: GatewayProfile;
  isActive: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  renameValue: string;
  renameError: string | null;
  renameBusy: boolean;
  applying: boolean;
  applyError: string | null;
  confirmingDelete: boolean;
  deleting: boolean;
  deleteError: string | null;
  onStartRename: () => void;
  onRenameValueChange: (value: string) => void;
  onRename: () => void;
  onCancelRename: () => void;
  onSelect: () => void;
  onApply: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
};

function GatewayProfileRow({
  profile,
  isActive,
  isSelected,
  isRenaming,
  renameValue,
  renameError,
  renameBusy,
  applying,
  applyError,
  confirmingDelete,
  deleting,
  deleteError,
  onStartRename,
  onRenameValueChange,
  onRename,
  onCancelRename,
  onSelect,
  onApply,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: GatewayProfileRowProps) {
  return (
    <div
      className={`rounded border p-3 text-sm ${isSelected ? "border-[var(--primary)] bg-[var(--primary)]/5" : ""}`}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <Input
              aria-label="Rename profile"
              autoFocus
              className="h-7 w-full text-sm"
              disabled={renameBusy}
              onChange={(e) => onRenameValueChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onRename();
                }
                if (e.key === "Escape") {
                  onCancelRename();
                }
              }}
              type="text"
              value={renameValue}
            />
          ) : (
            <div className="flex items-center gap-2">
              <p className="truncate font-medium">{profile.name}</p>
              {isActive && (
                <Badge className="shrink-0 text-[10px]" variant="default">
                  Active
                </Badge>
              )}
            </div>
          )}
          <p className="mt-0.5 truncate font-mono text-[var(--muted-foreground)] text-xs">
            {profile.relayOrigin}
          </p>
          <p className="mt-0.5 truncate font-mono text-[var(--muted-foreground)] text-xs">
            {profile.apiOrigin} - {profile.webAppOrigin}
          </p>
        </div>
        <div className="ml-2 flex shrink-0 gap-2">
          {isRenaming ? (
            <>
              <Button
                disabled={renameBusy}
                onClick={onRename}
                size="sm"
                variant="outline"
              >
                {renameBusy ? "Saving..." : "Save"}
              </Button>
              <Button
                disabled={renameBusy}
                onClick={onCancelRename}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                aria-label="Rename profile"
                onClick={onStartRename}
                size="sm"
                title="Rename profile"
                variant="ghost"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                aria-label="Delete profile"
                onClick={onStartDelete}
                size="sm"
                title="Delete profile"
                variant="ghost"
              >
                <Trash2 className="h-3.5 w-3.5 text-[var(--destructive)]" />
              </Button>
              {!isSelected && (
                <Button onClick={onSelect} size="sm" variant="ghost">
                  Select
                </Button>
              )}
              {!isActive && (
                <Button
                  disabled={applying}
                  onClick={onApply}
                  size="sm"
                  variant="outline"
                >
                  {applying ? "Applying..." : "Apply"}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {isRenaming && renameError && (
        <p className="mt-1 text-[var(--destructive)] text-xs">{renameError}</p>
      )}
      {applyError && (
        <p className="mt-1 text-[var(--destructive)] text-xs">{applyError}</p>
      )}
      {confirmingDelete && (
        <div className="mt-2 rounded border border-[var(--destructive)] bg-[var(--destructive)]/5 px-3 py-2">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-[var(--destructive)] text-xs">
              Delete "{profile.name}"? This cannot be undone.
            </p>
            <Button
              disabled={deleting}
              onClick={onConfirmDelete}
              size="sm"
              variant="destructive"
            >
              {deleting ? "Deleting..." : "Delete"}
            </Button>
            <Button
              disabled={deleting}
              onClick={onCancelDelete}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
          {deleteError && (
            <p className="mt-2 text-[var(--destructive)] text-xs">
              {deleteError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-24 shrink-0 text-[var(--muted-foreground)]">
        {label}
      </span>
      <span className={`truncate ${mono ? "font-mono" : ""}`}>
        {value || "—"}
      </span>
    </div>
  );
}

const gatewayPortSchema = z.number().int().min(1).max(65_535);

const gatewayConnectionSecuritySchema = z
  .object({
    detail: z.string().optional(),
    mode: z
      .union([
        z.literal(ConnectionSecurityMode.Enhanced),
        z.literal(ConnectionSecurityMode.SigningUnavailable),
        z.literal(ConnectionSecurityMode.Standard),
        z.literal(ConnectionSecurityMode.Unconfigured),
      ])
      .optional()
      .catch(undefined),
  })
  .passthrough();

const gatewayRuntimeStatusSchema = z
  .object({
    connectionSecurity: gatewayConnectionSecuritySchema
      .optional()
      .catch(undefined),
    gatewayHealthy: z.boolean().optional().catch(undefined),
    port: gatewayPortSchema.optional().catch(undefined),
    serverAlive: z.boolean().optional().catch(undefined),
  })
  .passthrough();

type GatewayRuntimeStatus = z.infer<typeof gatewayRuntimeStatusSchema>;

function parseGatewayRuntimeStatus(
  status: unknown
): GatewayRuntimeStatus | null {
  const result = gatewayRuntimeStatusSchema.safeParse(status);
  return result.success ? result.data : null;
}

const OFFLINE_GATEWAY_STATUS = {
  dotClassName: "bg-[var(--destructive)]",
  label: "Offline",
  textClassName: "text-foreground",
} as const;

function getGatewayHealthStatus(status: GatewayRuntimeStatus | null): {
  dotClassName: string;
  label: string;
  textClassName: string;
} {
  // Map the gateway runtime signals into three at-a-glance buckets. `serverAlive`
  // is the reachability signal (is the local gateway server listening) and
  // `gatewayHealthy` is the health signal (has recovery/liveness confirmed it):
  //   - Offline: the server is confirmed down, or we have no status at all
  //     (unreachable / gateway down).
  //   - Connected: reachable and healthy.
  //   - Needs Attention: reachable but not healthy (e.g. recovering, liveness
  //     probe failing) — degraded rather than fully offline.
  if (status?.serverAlive === false) {
    return OFFLINE_GATEWAY_STATUS;
  }
  if (status?.gatewayHealthy === true) {
    return {
      dotClassName: "bg-[var(--success)]",
      label: "Connected",
      textClassName: "text-foreground",
    };
  }
  if (status?.gatewayHealthy === false) {
    return {
      dotClassName: "bg-[var(--warning)]",
      label: "Needs Attention",
      textClassName: "text-foreground",
    };
  }
  return OFFLINE_GATEWAY_STATUS;
}

function formatRuntimeStatusValue(value: unknown): string {
  const result = gatewayPortSchema.safeParse(value);
  return result.success ? result.data.toString() : "";
}

function formatConnectionSecurityValue(
  value: GatewayRuntimeStatus["connectionSecurity"]
): string {
  if (value?.detail && value.detail.trim().length > 0) {
    return value.detail;
  }
  if (value?.mode) {
    return value.mode.replaceAll("_", " ");
  }
  return "";
}
