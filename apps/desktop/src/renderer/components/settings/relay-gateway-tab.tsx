import { Section } from "@closedloop-ai/design-system/components/ui/layout/section";
import { Switch } from "@closedloop-ai/design-system/components/ui/switch";
import { useEffect, useRef, useState } from "react";
import { cleanIpcError, readBooleanField } from "../../clean-ipc-error";
import { useCloudStatus } from "../../hooks/use-cloud-status";
import {
  useCloudSyncBacklog,
  useCloudSyncProgress,
} from "../../hooks/use-cloud-sync-progress";
import { useComputeTargetLinkBlock } from "../../hooks/use-compute-target-link-block";
import { ComputeTargetLinkBlockAlert } from "./compute-target-link-block-alert";
import { ConnectionStatusSection } from "./connection-status-section";
import { GatewayProfilesCard } from "./gateway-profiles-card";
import { ConfigRow } from "./settings-config-row";

/**
 * ISS-7043: Settings → Relay/Gateway — connection status, the read-only origin
 * configuration, saved gateway profiles, and the three cloud/runtime toggles.
 *
 * Extracted verbatim from SettingsPanel.tsx so
 * that file trends smaller per the repo file-size discipline. `active` is
 * threaded down from the panel because the polled cloud hooks below must stop
 * when the tab is not the visible one.
 */
export function RelayGatewayTab({
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
  // ISS-11426: the link block rides the SAME 1s poller, not the one-shot
  // `runtime` snapshot below — the block latches and clears at sync time, so a
  // mount-time read would miss a refusal that starts while this tab is open and
  // would keep the alert up after a successful relink (codex review).
  const computeTargetLinkBlock = useComputeTargetLinkBlock(active);
  // FEA-3067: the enable switch is desired configuration; the polled socket
  // state is the actual connection. Keep the two distinct so an enabled but
  // degraded socket cannot be mislabeled as connected.
  const cloudStatus = useCloudStatus(active);

  useEffect(() => {
    let cancelled = false;
    // Two separate reasons to drop a late getter, and they are not the same
    // concern: `cancelled` means this effect was torn down (unmount, or
    // StrictMode's mount-time re-run), `userToggled` means the user already
    // applied a value this read would overwrite. Both must hold to publish.
    const shouldApply = () => !(cancelled || userToggled.current);
    const applyPaused = (p: unknown) => {
      if (shouldApply()) {
        setPaused(Boolean(p));
      }
    };
    const applyConnection = (enabled: unknown) => {
      if (shouldApply()) {
        setConnectionEnabled(Boolean(enabled));
      }
    };
    const applyHooks = (h: unknown) => {
      if (shouldApply()) {
        setHooksEnabled(Boolean(h));
      }
    };
    const markInitialized = () => {
      if (!cancelled) {
        setInitialized(true);
      }
    };
    window.desktopApi
      .getRuntimeStatus()
      .then((r) => {
        if (!cancelled) {
          setRuntime(r as Record<string, unknown>);
        }
      })
      .catch(() => {});
    Promise.allSettled([
      window.desktopApi.getCloudCommandsPaused().then(applyPaused),
      window.desktopApi.getCloudConnectionEnabled().then(applyConnection),
      window.desktopApi.getAgentMonitorHooksEnabled().then(applyHooks),
    ])
      .then(markInitialized)
      .catch(markInitialized);
    return () => {
      cancelled = true;
    };
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
      {/* ISS-11426: above Connection Status, which is the surface that already
          owns this machine's cloud identity — the refusal is why that section's
          History Sync cell has stopped advancing. */}
      <ComputeTargetLinkBlockAlert block={computeTargetLinkBlock} />
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
