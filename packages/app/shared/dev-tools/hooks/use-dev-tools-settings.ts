"use client";

import { useCallback } from "react";
import { useLocalStorageState } from "../../hooks/use-local-storage-state";
import { booleanRecordOrFallback } from "../../lib/local-storage-validators";
import {
  applyDevToolsSetting,
  type DevToolsSetting,
  type DevToolsSettings,
} from "../lib/dev-tools-settings";

export type DevToolsSettingsState = {
  settings: DevToolsSettings;
  setSetting: (
    controlId: string,
    setting: DevToolsSetting,
    defaultValue: boolean | undefined
  ) => void;
  resetAll: () => void;
};

/**
 * ISS-12048: one section's settings, persisted in this browser under
 * `storageKey`. `useLocalStorageState` also notifies this window's `storage`
 * listeners on write, which is how `@repo/analytics` picks up a flag override
 * without a reload.
 */
export function useDevToolsSettings(storageKey: string): DevToolsSettingsState {
  const [settings, setSettings] = useLocalStorageState<DevToolsSettings>(
    storageKey,
    NO_SETTINGS,
    booleanRecordOrFallback
  );

  const setSetting = useCallback(
    (
      controlId: string,
      setting: DevToolsSetting,
      defaultValue: boolean | undefined
    ) =>
      setSettings((current) =>
        applyDevToolsSetting(current, controlId, setting, defaultValue)
      ),
    [setSettings]
  );

  const resetAll = useCallback(() => setSettings(NO_SETTINGS), [setSettings]);

  return { settings, setSetting, resetAll };
}

const NO_SETTINGS: DevToolsSettings = Object.freeze({});
