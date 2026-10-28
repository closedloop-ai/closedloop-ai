"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { useState } from "react";
import { SessionFrustrationToggleCard } from "../../components/session-frustration-card";
import {
  useFrustrationSetting,
  useSetFrustrationSetting,
} from "../../hooks/use-frustration-setting";
import { SettingsPanelDataStateView } from "../components/settings-panel-data-state-view";
import { SettingsPanelSection } from "../components/settings-panel-section";
import { SETTINGS_WRITE_UNAVAILABLE_MESSAGE } from "../components/settings-write-outcome-alert";
import {
  classifySettingsPanelError,
  classifySettingsPanelRead,
  SettingsPanelDataState,
} from "../lib/settings-panel-data-state";

const OTHER_LABS_SUBJECT = "your Labs settings";

/**
 * The Settings v2 Other Labs Settings panel (ISS-8369).
 *
 * DEFAULT-OFF (AC3). The switch's `checked` is only ever the value the server
 * actually returned. Every other outcome — still loading, refused, unreachable,
 * failed — renders its own screen and NO switch at all, so an unread setting can
 * never be painted as on, and a user can never flip a control whose current
 * value is unknown. The setting itself defaults off server-side because it is
 * derived from prompt content.
 *
 * SAVE OUTCOMES stay separate too: the write is admin-gated server-side, so a
 * member's toggle comes back 403 and is told that, rather than "try again" —
 * advice that cannot work. Hiding the switch is NOT the boundary here; the
 * route enforces it.
 */
export function OtherLabsSettingsPanel() {
  const setting = useFrustrationSetting();
  const saveSetting = useSetFrustrationSetting();
  const [saveState, setSaveState] = useState<SettingsPanelDataState | null>(
    null
  );

  const dataState = classifySettingsPanelRead({
    error: setting.error,
    hasData: setting.data !== undefined,
    // A single scalar setting is never an empty collection; the panel always has
    // this one control once the read lands.
    isEmpty: false,
    isPending: setting.isPending,
  });

  const handleToggle = async (nextChecked: boolean) => {
    setSaveState(null);
    try {
      await saveSetting.mutateAsync(nextChecked);
    } catch (error) {
      setSaveState(classifySettingsPanelError(error));
    }
  };

  return (
    <SettingsPanelSection
      description="Try experimental organization features before they become generally available."
      title="Other Labs Settings"
    >
      {dataState === SettingsPanelDataState.Ready && setting.data ? (
        <>
          {saveState === null ? null : <SaveOutcomeAlert state={saveState} />}
          <SessionFrustrationToggleCard
            checked={setting.data.calculateSessionFrustration}
            hasSaveError={saveState === SettingsPanelDataState.Failed}
            isSaving={saveSetting.isPending}
            onToggle={handleToggle}
          />
        </>
      ) : (
        // Framed like the panel's ready state rather than floating bare in the
        // section, so the five outcomes are one screen changing its contents
        // instead of two different layouts.
        <Card>
          <CardHeader>
            <CardTitle>Experimental analysis</CardTitle>
            <CardDescription>
              Labs settings may change as we learn from early usage.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SettingsPanelDataStateView
              onRetry={() => {
                setting.refetch();
              }}
              state={dataState}
              subject={OTHER_LABS_SUBJECT}
            />
          </CardContent>
        </Card>
      )}
    </SettingsPanelSection>
  );
}

/**
 * Why a save did not take, when the reason is not "it went wrong, try again".
 *
 * Renders nothing for `failed`: the reused toggle card already owns that one
 * through `hasSaveError`, and two alerts for one outcome would be worse than
 * either. A refusal and an outage each get their own sentence here because the
 * card's single generic message tells the user to retry, which is wrong advice
 * for both.
 */
function SaveOutcomeAlert({
  state,
}: Readonly<{ state: SettingsPanelDataState }>) {
  if (state === SettingsPanelDataState.Forbidden) {
    return (
      <Alert variant="error">
        <AlertDescription>
          That change needs an organization admin. Your setting is unchanged.
        </AlertDescription>
      </Alert>
    );
  }
  if (state === SettingsPanelDataState.Unavailable) {
    // Imported rather than restated: ISS-8367 added a second panel speaking for
    // this same outcome, and two copies of one sentence drift the moment either
    // is reworded.
    return (
      <Alert variant="error">
        <AlertDescription>
          {SETTINGS_WRITE_UNAVAILABLE_MESSAGE}
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}
