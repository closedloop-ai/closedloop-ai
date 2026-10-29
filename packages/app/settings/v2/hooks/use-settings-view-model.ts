"use client";

import type {
  SettingsDomainGrants,
  SettingsDomainId,
} from "@repo/api/src/types/settings-domain";
import {
  NO_SETTINGS_DOMAIN_GRANTS,
  SettingsDomainStatus,
} from "@repo/api/src/types/settings-domain";
import {
  type SettingsActorCapabilities,
  SettingsActorCapabilityStatus,
} from "@repo/api/src/types/settings-panel";
import type { SettingsViewModel } from "@repo/api/src/types/settings-view-model";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useApiClient } from "../../../shared/api/use-api-client";

export const settingsViewModelKeys = {
  all: ["settings"] as const,
  viewModel: () => [...settingsViewModelKeys.all, "view-model"] as const,
};

/**
 * The actor's Settings authorization projection (`GET /settings/view-model`,
 * ISS-8378). ONE read for the whole surface — the shell's panel resolution and
 * every panel body share this query key, so mounting Settings costs a single
 * membership round-trip no matter how many panels ask.
 *
 * It carries AUTHORIZATION only. Panels still fetch their own payloads.
 */
export function useSettingsViewModel(
  options?: Omit<UseQueryOptions<SettingsViewModel>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: settingsViewModelKeys.viewModel(),
    queryFn: () => apiClient.get<SettingsViewModel>("/settings/view-model"),
    ...options,
  });
}

/**
 * What one domain's access question turned out to be, for a panel body that
 * needs to gate a control on a rung finer than the one the shell already
 * enforced to let it mount at all.
 *
 * Three arms, never folded: a read still in flight, a read that FAILED, and a
 * settled answer. Only the settled arm carries grants — a failed read has no
 * grants to report, and `NO_SETTINGS_DOMAIN_GRANTS` handed to a caller here
 * would render as a confident denial (PRD-692 forbids exactly that).
 */
export type SettingsDomainAccessState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "settled"; grants: SettingsDomainGrants };

/**
 * The shell's half of the same read (ISS-8370 M1): the actor projection in the
 * shape `resolveSettingsPanel` consumes, plus the retry the capability-error
 * screen offers. `Pending` while the read is in flight and `Error` when it
 * failed — never a fabricated grant or denial — so the shell renders those as
 * their own screens (PRD-692).
 */
export function useSettingsShellCapabilities(): {
  capabilities: SettingsActorCapabilities;
  retry: () => void;
} {
  const { data, isPending, isError, refetch } = useSettingsViewModel();
  const retry = useCallback(() => {
    refetch().catch(() => undefined);
  }, [refetch]);

  if (isPending) {
    return { capabilities: PENDING_ACTOR_CAPABILITIES, retry };
  }
  if (isError || data === undefined) {
    return { capabilities: FAILED_ACTOR_CAPABILITIES, retry };
  }
  return { capabilities: data.capabilities, retry };
}

export function useSettingsDomainAccess(
  domain: SettingsDomainId
): SettingsDomainAccessState {
  const { data, isPending, isError } = useSettingsViewModel();

  if (isPending) {
    return { status: "pending" };
  }
  // A transport failure and a domain the server could not decide are the same
  // fact to a panel: nobody can say what this actor may do here.
  if (isError || data === undefined) {
    return { status: "error" };
  }

  const access = data.domains[domain];
  if (access === undefined || access.status === SettingsDomainStatus.Error) {
    return { status: "error" };
  }

  return {
    grants: access.grants ?? NO_SETTINGS_DOMAIN_GRANTS,
    status: "settled",
  };
}

const PENDING_ACTOR_CAPABILITIES: SettingsActorCapabilities = Object.freeze({
  status: SettingsActorCapabilityStatus.Pending,
});

const FAILED_ACTOR_CAPABILITIES: SettingsActorCapabilities = Object.freeze({
  status: SettingsActorCapabilityStatus.Error,
});
