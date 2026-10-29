"use client";

import type { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import { useCallback } from "react";
import { SettingsPanelDataState } from "../lib/settings-panel-data-state";
import {
  useSettingsDomainAccess,
  useSettingsViewModel,
} from "./use-settings-view-model";

/**
 * Whether the actor holds the `admin` rung on one domain, for a card that
 * renders admin-only controls inside a panel any member may open (ISS-10316).
 *
 * `accessState` is `Loading` while the view model is in flight and `Failed`
 * when it could not be read. A card renders that state INSTEAD of its
 * controls, so a control whose admin-ness is unknown is never drawn. `isAdmin`
 * is `false` in both of those states and only means "not an admin" once
 * `accessState` is `Ready`.
 *
 * Hiding a control is not the boundary. The routes behind these writes check
 * the role again, and a card still has to render their 403.
 */
export function useSettingsAdminGate(
  domain: SettingsDomainId
): SettingsAdminGate {
  const access = useSettingsDomainAccess(domain);
  const { refetch } = useSettingsViewModel();
  const onRetry = useCallback(() => {
    refetch().catch(() => undefined);
  }, [refetch]);

  if (access.status === "pending") {
    return {
      accessState: SettingsPanelDataState.Loading,
      isAdmin: false,
      onRetry,
    };
  }
  if (access.status === "error") {
    return {
      accessState: SettingsPanelDataState.Failed,
      isAdmin: false,
      onRetry,
    };
  }
  return {
    accessState: SettingsPanelDataState.Ready,
    isAdmin: access.grants.admin,
    onRetry,
  };
}

export type SettingsAdminGate = {
  accessState: SettingsPanelDataState;
  isAdmin: boolean;
  onRetry: () => void;
};
