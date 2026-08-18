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
import { Section } from "@closedloop-ai/design-system/components/ui/layout/section";
import { Switch } from "@closedloop-ai/design-system/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@closedloop-ai/design-system/components/ui/tabs";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BinaryResolveSource,
  CLI_BINARY_TOOLS,
} from "../../../shared/cli-binary-tools";
import { cleanIpcError, readBooleanField } from "../../clean-ipc-error";
import {
  useCloudStatus,
  useCloudSyncBacklog,
  useCloudSyncProgress,
} from "../../hooks/use-ingest-progress";
import { pageTitleForNav } from "../../navigation/nav-config";
import { NavId } from "../../navigation/route-table";
import { useLabsSettingsTabEnabled } from "../../navigation/use-nav-gates";
import { PageShell } from "../layout/page-shell";
import { ConnectionStatusSection } from "./connection-status-section";
import { DataCollectionCard } from "./data-collection-card";
import { DataSyncTab } from "./data-sync-tab";
import { DesktopAccountTab } from "./desktop-account-tab";
import { ProfileConnectionFields } from "./gateway-profile-connection-fields";
import { GatewayProfileRow } from "./gateway-profile-row";
import { GlobalSandboxSection } from "./global-sandbox-card";
import { LabsTab } from "./labs-tab";
import { SecurityFlagsSection } from "./security-flags-section";
import { ConfigRow } from "./settings-config-row";
import {
  DEFAULT_SETTINGS_TAB,
  isVisibleSettingsTab,
  LABS_SETTINGS_TAB,
  resolveVisibleSettingsTab,
  type SettingsTab,
  visibleSettingsTabs,
} from "./settings-tabs";

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
  /**
   * FEA-4005: per-profile sandbox scope root. Absent on profiles saved before
   * this field existed — those fall back to the global sandbox on apply.
   */
  sandboxBaseDirectory?: string;
};

export type GatewayProfileFormState = {
  name: string;
  relayOrigin: string;
  apiOrigin: string;
  webAppOrigin: string;
  apiKey: string;
  /** FEA-4005: editable sandbox scope root for this profile. */
  sandboxBaseDirectory: string;
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
    // FEA-4005: seed the field only from the profile's OWN sandbox. Leaving it
    // empty means "inherit the global sandbox" — we no longer default it to the
    // current global value, which would silently pin a legacy profile to today's
    // global path on any unrelated Save (and then restore that stale snapshot on
    // a later Apply). The global sandbox is shown as a placeholder hint instead.
    sandboxBaseDirectory: profile?.sandboxBaseDirectory ?? "",
  };
}

function isProfileFormComplete(form: GatewayProfileFormState): boolean {
  // The sandbox is optional (empty = inherit the global sandbox), so it does not
  // gate completeness; a bad non-empty value is rejected in the main process.
  return (
    form.name.trim().length > 0 &&
    form.relayOrigin.trim().length > 0 &&
    form.apiOrigin.trim().length > 0 &&
    form.webAppOrigin.trim().length > 0
  );
}

/**
 * @param deepLinkTab - ISS-5310 (stage cid 3726701529): the tab an in-renderer
 * link asked for, read off `?tab=` by the SHELL and passed down. It is a prop
 * rather than a `useSearchParamsValue()` call here on purpose: this component
 * has eleven unit-test mount sites that supply no `NavigationProvider`, and a
 * newly unconditional provider-requiring hook would take every one of them down.
 * The shell already sits inside the provider, so reading it there costs nothing.
 */
export function SettingsPanel({
  deepLinkTab = null,
}: Readonly<{ deepLinkTab?: string | null }> = {}) {
  const [tab, setTab] = useState<SettingsTab>("relay-gateway");
  const [settings, setSettings] = useState<Record<string, unknown> | null>(
    null
  );
  // Once the user (or a deep-link) picks a tab, stop auto-selecting a default so
  // settings finishing loading never yanks them off their choice.
  const tabChosenRef = useRef(false);
  // ISS-5309: the same `labsNav` container flag that hides the sidebar Labs
  // section, arriving over the same `desktop:flags-changed` broadcast — so the
  // tab appears and disappears live, with no relaunch.
  const labsTabOn = useLabsSettingsTabEnabled();
  const tabs = visibleSettingsTabs(labsTabOn);
  // The tab actually shown. Derived, not synced through an effect, so a user
  // sitting on Labs when the toggle flips off never renders a
  // selected-but-empty tab — see `resolveVisibleSettingsTab`.
  const activeTab = resolveVisibleSettingsTab(tab, labsTabOn);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  // ISS-5309 (visual-QA review): Radix Tabs uses a roving tabindex, so when the
  // selected Labs trigger UNMOUNTS under a keyboard user — the toggle flipped
  // while they were sitting on it — the focus target unmounts with it and focus
  // silently falls back to <body>, dumping them at the top of the document.
  //
  // Only orphaned focus is recovered: if the user was not on the withdrawn tab,
  // `document.activeElement` is still something real and we leave it alone,
  // because moving focus nobody asked to move is its own bug. Moving it to the
  // now-selected trigger also gives screen readers something to announce, which
  // the silent content swap otherwise had nothing of.
  useEffect(() => {
    if (activeTab === tab) {
      return;
    }
    const focused = document.activeElement;
    if (focused && focused !== document.body) {
      return;
    }
    tabsRef.current
      ?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
      ?.focus();
  }, [activeTab, tab]);

  useEffect(() => {
    window.desktopApi
      .getSettings()
      .then((s) => {
        const record = s as Record<string, unknown>;
        setSettings(record);
        // Account is the first tab; default to it unless the user (or a
        // deep-link) has already chosen one.
        if (!tabChosenRef.current) {
          setTab(DEFAULT_SETTINGS_TAB);
        }
      })
      .catch(() => {});
  }, []);

  // ISS-5310 (stage cid 3726701529): the IN-RENDERER deep link, e.g. the Agents
  // "turned off" panel's "Open settings" button, which promised Settings → Labs
  // and delivered Account. It cannot use the `desktop:navigate-settings-tab`
  // event below — `Link` navigates AFTER a click handler would have fired, so a
  // dispatch at the call site races this component's own mount and is dropped.
  // The query param is state, so there is no race to lose.
  //
  // Depends on `labsTabOn`: the flag snapshot lands asynchronously, so a
  // `?tab=labs` link opened before it arrives is re-resolved once it does,
  // instead of being rejected on the first render and silently forgotten.
  useEffect(() => {
    if (deepLinkTab === null || !isVisibleSettingsTab(deepLinkTab, labsTabOn)) {
      return;
    }
    tabChosenRef.current = true;
    setTab(deepLinkTab);
  }, [deepLinkTab, labsTabOn]);

  useEffect(() => {
    const handler = (e: CustomEvent<string>) => {
      // A deep link to a HIDDEN tab is ignored outright rather than accepted and
      // then resolved away: accepting it would also latch `tabChosenRef`, which
      // would strand the panel on its pre-load tab once settings resolve.
      if (isVisibleSettingsTab(e.detail, labsTabOn)) {
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
  }, [labsTabOn]);

  return (
    <PageShell
      description="Desktop preferences, gateway connection and cloud sync."
      title={pageTitleForNav(NavId.Settings)}
    >
      <Tabs
        onValueChange={(value) => {
          if (isVisibleSettingsTab(value, labsTabOn)) {
            tabChosenRef.current = true;
            setTab(value);
          }
        }}
        ref={tabsRef}
        value={activeTab}
      >
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="account">
          <DesktopAccountTab />
        </TabsContent>
        <TabsContent value="relay-gateway">
          <RelayGatewayTab
            active={activeTab === "relay-gateway"}
            onSettingsChange={setSettings}
            settings={settings}
          />
        </TabsContent>
        <TabsContent value="data-sync">
          <DataSyncTab />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab onSettingsChange={setSettings} settings={settings} />
        </TabsContent>
        <TabsContent value="binary-paths">
          <BinaryPathsTab />
        </TabsContent>
        {labsTabOn && (
          <TabsContent value={LABS_SETTINGS_TAB}>
            <LabsTab onSettingsChange={setSettings} settings={settings} />
          </TabsContent>
        )}
      </Tabs>
    </PageShell>
  );
}

function RelayGatewayTab({
  active,
  settings,
  onSettingsChange,
}: {
  active: boolean;
  settings: Record<string, unknown> | null;
  onSettingsChange?: (s: Record<string, unknown>) => void;
}) {
  const [runtime, setRuntime] = useState<Record<string, unknown> | null>(null);
  const [paused, setPaused] = useState(false);
  const [connectionEnabled, setConnectionEnabled] = useState<boolean | null>(
    null
  );
  const [hooksEnabled, setHooksEnabled] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hooksError, setHooksError] = useState<string | null>(null);
  // The mount-time getters are async, so a user could toggle a switch before
  // the initial read resolves; a late getter must not clobber the value the
  // user just applied. `initialized` disables the toggles until the reads
  // settle, and `userToggled` makes any getter that resolves afterward a no-op.
  const [initialized, setInitialized] = useState(false);
  const userToggled = useRef(false);
  // FEA-3256: cloud-sync progress is inherently dynamic — a first-connect
  // backfill drains over minutes/hours — so the History Sync cell must track
  // the shared 1s runtime-status poll while this tab is open rather than the
  // one-shot `runtime` snapshot below, which froze the cell (FEA-2733) at the
  // value captured on mount.
  const cloudSyncProgress = useCloudSyncProgress(active);
  // ISS-5768: the whole-app backlog behind the History Sync cell's completeness
  // claim. Same shared 1s poller as `cloudSyncProgress` — no extra IPC.
  const cloudSyncBacklog = useCloudSyncBacklog(active);
  // FEA-3067: the enable switch is desired configuration; the polled socket
  // state is the actual connection. Keep the two distinct so an enabled but
  // degraded socket cannot be mislabeled as connected.
  const cloudStatus = useCloudStatus(active);

  useEffect(() => {
    window.desktopApi
      .getRuntimeStatus()
      .then((r) => setRuntime(r as Record<string, unknown>))
      .catch(() => {});
    // A getter that resolves after the user has already toggled must not
    // overwrite the value they just applied, so every apply is guarded on
    // `userToggled`.
    const applyPaused = (p: unknown) => {
      if (!userToggled.current) {
        setPaused(Boolean(p));
      }
    };
    const applyConnection = (enabled: unknown) => {
      if (!userToggled.current) {
        setConnectionEnabled(Boolean(enabled));
      }
    };
    const applyHooks = (h: unknown) => {
      if (!userToggled.current) {
        setHooksEnabled(Boolean(h));
      }
    };
    Promise.allSettled([
      window.desktopApi.getCloudCommandsPaused().then(applyPaused),
      window.desktopApi.getCloudConnectionEnabled().then(applyConnection),
      window.desktopApi.getAgentMonitorHooksEnabled().then(applyHooks),
    ])
      .then(() => setInitialized(true))
      .catch(() => setInitialized(true));
  }, []);

  const handlePauseToggle = async (next: boolean) => {
    userToggled.current = true;
    setPauseError(null);
    try {
      const result = await window.desktopApi.setCloudCommandsPaused(next);
      // The setter reads back the post-set field from the source of truth
      // (`{ paused }`); trust it over the requested value so a requested/actual
      // mismatch (e.g. golden mode) is reflected, not the request. Older
      // desktop builds resolve without the readback — fall back to `next`.
      setPaused(readBooleanField(result, "paused", next));
    } catch (err) {
      setPauseError(cleanIpcError(err, "Failed to update pause setting"));
    }
  };

  const handleConnectionToggle = async (next: boolean) => {
    userToggled.current = true;
    setConnectionError(null);
    try {
      const result = await window.desktopApi.setCloudConnectionEnabled(next);
      setConnectionEnabled(readBooleanField(result, "enabled", next));
    } catch (err) {
      setConnectionError(
        cleanIpcError(err, "Failed to update cloud connection")
      );
    }
  };

  const handleHooksToggle = async (next: boolean) => {
    userToggled.current = true;
    setHooksError(null);
    try {
      const result = await window.desktopApi.setAgentMonitorHooksEnabled(next);
      // The IPC resolves with the actual post-apply state. `ok: false` is a
      // resolved failure (not a reject), so surface its error; either way the
      // switch follows `result.enabled`, which may differ from the request
      // (e.g. the master hook toggle inert => enable resolves `enabled: false`).
      if (result.ok === false) {
        setHooksError(result.error ?? "Failed to update session tracking");
      }
      setHooksEnabled(Boolean(result.enabled));
    } catch (err) {
      setHooksError(cleanIpcError(err, "Failed to update session tracking"));
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <ConnectionStatusSection
        cloudConnectionEnabled={connectionEnabled}
        cloudStatus={cloudStatus}
        cloudSyncBacklog={cloudSyncBacklog}
        cloudSyncProgress={cloudSyncProgress}
        gatewayHealthy={runtime?.gatewayHealthy}
        gatewayPort={runtime?.port}
        remoteCommandsPaused={paused}
        security={runtime?.connectionSecurity}
        serverAlive={runtime?.serverAlive}
      />

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
              disabled={!initialized}
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
              checked={connectionEnabled === true}
              disabled={!initialized}
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
              disabled={!initialized}
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
  onSettingsChange,
}: {
  settings: Record<string, unknown> | null;
  onSettingsChange: (s: Record<string, unknown>) => void;
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
        cleanIpcError(err, "Failed to update auto-approve setting")
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
      setApiKeyError(cleanIpcError(err, "Failed to set API key"));
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
      setApiKeyError(cleanIpcError(err, "Failed to clear API key"));
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

          <GlobalSandboxSection
            onSettingsChange={onSettingsChange}
            settings={settings}
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

          <SecurityFlagsSection
            onSettingsChange={onSettingsChange}
            settings={settings}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// FEA-3741 (slice 1): the per-tool collector enable toggles live in their own
// "Data Collection" category so they render beside the CLI tools they collect
// from (not in the generic Labs list — they are `hiddenFromLabs`). Default ON.
// One tool's resolved state, as returned by `detectCliTools()`. `source`
// mirrors the resolver's BinaryResolveResult.source: a real path was found via
// an override, the login-shell PATH, or a known install location — or nothing
// was found ("fallback").
type BinaryDetectEntry = {
  name: string;
  override: string | null;
  source: BinaryResolveSource;
  resolvedPath: string | null;
};

function coerceDetectMap(raw: unknown): Record<string, BinaryDetectEntry> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, BinaryDetectEntry> = {};
  for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === "object" && "source" in value) {
      out[tool] = value as BinaryDetectEntry;
    }
  }
  return out;
}

// Single edge for the CLI-tool text column: both the resolved mono path line
// and the not-found guidance cap at this width so they share one column edge
// (rather than two hand-picked pixel widths). `max-w-xs` is the on-scale
// Tailwind token (20rem), not an arbitrary value. FEA-3742.
const CLI_TEXT_COLUMN = "max-w-xs";

// Actionable "why we couldn't resolve this CLI" status shown in place of a
// resolved path. Distinguishes a bad manual override from a genuine
// not-found-anywhere state, and points the user at the self-serve remedies
// (Detect Tools / Edit override / `which`). FEA-3742.
function BinaryNotFoundStatus({
  tool,
  overrideInvalid,
}: {
  tool: string;
  overrideInvalid: boolean;
}) {
  return (
    <div className="mt-0.5 space-y-0.5">
      <p className="font-medium text-[var(--destructive)] text-xs">
        {overrideInvalid ? "Override path is invalid" : "Not found"}
      </p>
      <p
        className={`${CLI_TEXT_COLUMN} text-[var(--muted-foreground)] text-xs leading-snug`}
      >
        {overrideInvalid ? (
          <>
            The path you set doesn&apos;t exist or isn&apos;t executable. Click{" "}
            <span className="font-medium">Edit</span> to correct it, or clear it
            to auto-detect again.
          </>
        ) : (
          <>
            Couldn&apos;t find {tool}. If it&apos;s installed, try{" "}
            <span className="font-medium">Detect Tools</span>, or{" "}
            <span className="font-medium">Edit</span> to set its full path (run{" "}
            <code className="font-mono">which {tool}</code> to find it).
          </>
        )}
      </p>
    </div>
  );
}

function BinaryPathsTab() {
  const [detected, setDetected] = useState<Record<string, BinaryDetectEntry>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  // Run detection (login-shell PATH + known-location probe) so the tab shows
  // the actual resolved binary, not just manually-set overrides. FEA-3742.
  useEffect(() => {
    window.desktopApi
      .detectCliTools()
      .then((result) => {
        setDetected(coerceDetectMap(result));
        setLoading(false);
      })
      .catch(() => {
        // IPC rejected: stop showing the loading placeholder so the tab does
        // not hang on "Detecting tools...".
        setLoading(false);
      });
  }, []);

  const handleDetect = async () => {
    setLoading(true);
    try {
      const result = await window.desktopApi.detectCliTools();
      setDetected(coerceDetectMap(result));
    } catch {
      // IPC rejected: leave state as-is but stop the loading placeholder.
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (tool: string) => {
    setEditing(tool);
    setEditValue(
      detected[tool]?.override ?? detected[tool]?.resolvedPath ?? ""
    );
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditError(null);
  };

  const handleSave = async (tool: string) => {
    try {
      // Empty input clears the override (null), which re-enables auto-detection
      // — this is the "clear it to auto-detect again" remedy the not-found copy
      // points users at. A non-empty value sets the override. FEA-3742.
      await window.desktopApi.patchBinaryPaths({
        [tool]: editValue ? editValue : null,
      });
      const result = await window.desktopApi.detectCliTools();
      setDetected(coerceDetectMap(result));
    } catch (err) {
      setEditError(cleanIpcError(err, "Failed to save binary path"));
      return;
    }
    setEditing(null);
    setEditError(null);
  };

  return (
    <div className="mt-4 space-y-4">
      <DataCollectionCard />
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
            CLI_BINARY_TOOLS.map((tool) => {
              const entry = detected[tool];
              const found =
                entry != null &&
                entry.source !== "fallback" &&
                entry.source !== "override_invalid" &&
                entry.resolvedPath != null;
              return (
                <div
                  className="flex items-start justify-between rounded border p-3"
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
                    ) : found ? (
                      <p
                        className={`${CLI_TEXT_COLUMN} truncate font-mono text-[var(--muted-foreground)] text-xs`}
                      >
                        {entry.resolvedPath}
                      </p>
                    ) : (
                      <BinaryNotFoundStatus
                        overrideInvalid={entry?.source === "override_invalid"}
                        tool={tool}
                      />
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
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
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
  const globalSandbox = (settings?.sandboxBaseDirectory as string) || "";
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
  // ISS-4577 (wongk review): the per-profile sandbox field reports whether its
  // current value is a KNOWN-invalid path (settled risky root / missing dir).
  // The New-profile dialog and the selected-profile editor each gate their Save
  // on it so an invalid sandbox can no longer be persisted despite the inline
  // warning. Blank (inherit the global sandbox) is never invalid.
  const [newProfileSandboxInvalid, setNewProfileSandboxInvalid] =
    useState(false);
  const [selectedProfileSandboxInvalid, setSelectedProfileSandboxInvalid] =
    useState(false);
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
        message: cleanIpcError(err, "Failed to apply profile"),
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
      setRenameError(cleanIpcError(err, "Failed to rename profile"));
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
        message: cleanIpcError(err, "Failed to delete profile"),
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
        sandboxBaseDirectory?: string;
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
      const sandbox = newProfileForm.sandboxBaseDirectory.trim();
      if (sandbox) {
        payload.sandboxBaseDirectory = sandbox;
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
      setSaveError(cleanIpcError(err, "Failed to save profile"));
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
        sandboxBaseDirectory?: string;
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
      const sandbox = selectedForm.sandboxBaseDirectory.trim();
      if (sandbox) {
        payload.sandboxBaseDirectory = sandbox;
      }
      await window.desktopApi.saveConfig(payload);
      await refreshSettings();
      setSelectedForm((current) => ({ ...current, apiKey: "" }));
    } catch (err) {
      setProfileSaveError(cleanIpcError(err, "Failed to save profile"));
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
                globalSandbox={globalSandbox}
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
              globalSandbox={globalSandbox}
              onChange={(patch) => {
                setSelectedForm((current) => ({ ...current, ...patch }));
                setProfileSaveError(null);
              }}
              onEnter={() => {
                if (
                  !(
                    profileSaving ||
                    !isProfileFormComplete(selectedForm) ||
                    selectedProfileSandboxInvalid
                  )
                ) {
                  handleSaveSelectedProfile().catch(() => {});
                }
              }}
              onSandboxValidityChange={setSelectedProfileSandboxInvalid}
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
                disabled={
                  profileSaving ||
                  !isProfileFormComplete(selectedForm) ||
                  selectedProfileSandboxInvalid
                }
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
              globalSandbox={globalSandbox}
              onChange={(patch) => {
                setNewProfileForm((current) => ({ ...current, ...patch }));
                setSaveError(null);
              }}
              onEnter={() => {
                if (
                  !(
                    saving ||
                    !isProfileFormComplete(newProfileForm) ||
                    newProfileSandboxInvalid
                  )
                ) {
                  handleSaveProfile().catch(() => {});
                }
              }}
              onSandboxValidityChange={setNewProfileSandboxInvalid}
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
              disabled={
                saving ||
                !isProfileFormComplete(newProfileForm) ||
                newProfileSandboxInvalid
              }
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

type ProfileActionError = { id: string; message: string } | null;
