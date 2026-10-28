import { SettingsPanelDataStateView } from "@repo/app/settings/v2/components/settings-panel-data-state-view";
import { SettingsPanelSection } from "@repo/app/settings/v2/components/settings-panel-section";
import { SettingsPanelDataState } from "@repo/app/settings/v2/lib/settings-panel-data-state";
import { useCallback, useEffect, useRef, useState } from "react";
import { BinaryPathsTab } from "../../components/settings/binary-paths-tab";
import { DataSyncTab } from "../../components/settings/data-sync-tab";
import { RelayGatewayTab } from "../../components/settings/relay-gateway-tab";
import { SecurityTab } from "../../components/settings/security-tab";

/**
 * Settings v2 → Labs → Desktop App, the body (ISS-10286).
 *
 * THE CONTROLS ARE THE SHIPPED ONES, MOVED AND NOT REDRAWN. Each block below is
 * the legacy tab body that already owned it, mounted here instead of behind the
 * `Tabs` chrome of the legacy desktop Settings panel — which ISS-10195 left with
 * no production mount and ISS-10246 deleted. Re-authoring them would have been a
 * redesign nobody asked for and would have put a second copy of each control's
 * IPC handling in the tree; the point of this panel is that the controls get a
 * home again, unchanged.
 *
 * ONE `settings` READ, THREADED — the arrangement the legacy panel used, kept
 * for the same reason: Security and Relay/Gateway read and write the same
 * main-process settings record, so two independent reads would let one block
 * render a value the other had already superseded.
 *
 * A FAILED READ IS ITS OWN STATE, not a permanent `null` (whitlockk, #4032080278).
 * The legacy tabs read `settings?.x ?? <default>`, so `SecurityTab` renders Auth
 * Mode as `standard` against a null record — a rejected `getSettings()` would
 * otherwise present a failed local read as a real configuration, and stay that
 * way for the life of the mount because nothing re-ran the effect. The two
 * blocks that need the record therefore render
 * {@link SettingsPanelDataStateView} with a retry until it is actually held.
 *
 * DATA SYNC AND BINARY PATHS KEEP RENDERING THROUGH THAT FAILURE. They take no
 * `settings` prop and own their own reads, so withdrawing them because a
 * DIFFERENT read failed would delete two working capabilities to report one
 * broken one. The failure is scoped to the blocks whose operand is missing.
 *
 * `active` is `true` for Relay/Gateway because there are no tabs here: every
 * block is on screen, so the flag that used to mean "this tab is selected" can
 * only mean visible.
 *
 * ACCOUNT IS DELIBERATELY ABSENT. The legacy tree's fifth tab was sign-in and
 * GitHub connection, which is account identity rather than a machine-local
 * setting, and the v2 Profile panel is its owner on web. Folding it in here
 * would put account management under Labs → Desktop App, which is not what
 * either surface means. `/settings/account` therefore keeps its legacy `?tab=`
 * spelling and stays unowned — the one row of ISS-10286's stranding this panel
 * does not resolve. ISS-10246 deleted the tab's own component: each of its three
 * capabilities is reachable elsewhere on desktop (sign-in through guided
 * onboarding, sign-out through the workspace menu, GitHub connect through
 * Branches, Sessions and Insights), so nothing but the duplicate went.
 */
export function DesktopAppPanel() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(
    null
  );
  const [readState, setReadState] = useState<SettingsPanelDataState>(
    SettingsPanelDataState.Loading
  );
  // A ref rather than an effect-local `cancelled`, because the retry button
  // starts a read from OUTSIDE any effect and that read needs the same
  // after-unmount guard the mount read has.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const readSettings = useCallback(() => {
    setReadState(SettingsPanelDataState.Loading);
    window.desktopApi
      .getSettings()
      .then((value) => {
        if (mountedRef.current) {
          setSettings(value as Record<string, unknown>);
          setReadState(SettingsPanelDataState.Ready);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setReadState(SettingsPanelDataState.Failed);
        }
      });
  }, []);

  useEffect(() => {
    readSettings();
  }, [readSettings]);

  return (
    <SettingsPanelSection
      description="Settings this copy of the desktop app keeps on your machine."
      title="Desktop App"
    >
      <div className="flex flex-col gap-10">
        {readState === SettingsPanelDataState.Ready ? (
          <>
            <SecurityTab onSettingsChange={setSettings} settings={settings} />
            <RelayGatewayTab
              active
              onSettingsChange={setSettings}
              settings={settings}
            />
          </>
        ) : (
          <SettingsPanelDataStateView
            onRetry={readSettings}
            state={readState}
            subject="this machine's desktop settings"
          />
        )}
        <DataSyncTab />
        <BinaryPathsTab />
      </div>
    </SettingsPanelSection>
  );
}
