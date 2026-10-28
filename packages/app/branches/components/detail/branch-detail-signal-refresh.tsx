"use client";

import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { SignalTypes } from "@repo/realtime-contract/signals";
import { useRealtimeClient } from "../../../shared/realtime/realtime-provider";
import { useCoalescedReload } from "../../../shared/realtime/use-coalesced-reload";
import { useSignals } from "../../../shared/realtime/use-signals";
import { useCurrentUser } from "../../../users/hooks/use-users";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "../../data-source/provider";
import {
  type BranchesQueryIdentity,
  branchesKeys,
} from "../../hooks/use-branches";

type Props = { branchId: string; queryIdentity?: BranchesQueryIdentity };

export function BranchDetailSignalRefresh(props: Props) {
  const client = useRealtimeClient();
  return client ? <OrganizationBranchChannel {...props} /> : null;
}

function OrganizationBranchChannel({ branchId, queryIdentity }: Props) {
  const user = useCurrentUser();
  const source = useBranchesDataSource();
  const context = useBranchesQueryContext(queryIdentity);
  const key = branchesKeys.detail(
    source.scope,
    branchId,
    context.queryIdentity
  );
  const reload = useCoalescedReload(() =>
    context.queryClient.invalidateQueries({ queryKey: key.slice(0, -1) })
  );
  const channel = branchChannel(user.data?.organizationId, branchId);
  useSignals(channel, {
    types: SignalTypes[ChannelKind.Branches],
    onSignal: reload,
    onResync: reload,
    dataLoadedAt: () =>
      context.queryClient.getQueryState(key)?.dataUpdatedAt || undefined,
  });
  return null;
}

function branchChannel(
  organizationId: string | undefined,
  branchId: string
): string | null {
  if (!organizationId) {
    return null;
  }
  try {
    return formatChannelAddress(ChannelKind.Branches, organizationId, [
      branchId,
    ]);
  } catch {
    return null;
  }
}
