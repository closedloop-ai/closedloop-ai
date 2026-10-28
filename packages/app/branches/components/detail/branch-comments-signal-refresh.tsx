"use client";

import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { SignalTypes } from "@repo/realtime-contract/signals";
import { useRealtimeClient } from "../../../shared/realtime/realtime-provider";
import { useCoalescedReload } from "../../../shared/realtime/use-coalesced-reload";
import { useSignals } from "../../../shared/realtime/use-signals";
// The comments channel is addressed by the organization's id, which the
// current user carries; the Branch read does not.
import { useCurrentUser } from "../../../users/hooks/use-users";

export type BranchCommentsSignalRefreshProps = {
  branchId: string;
  /** See `RealtimeChannelListener.dataLoadedAt`. */
  dataLoadedAt: () => number | undefined;
  /** Reloads the Branch comments; resolves once the reload settles. */
  onCommentsChanged: () => Promise<unknown>;
};

/**
 * ISS-11212 (Kerensa, 2026-10-05: realtime signals only, no polling): reloads the
 * Branch comments when a thread on the branch's `comments` channel changes,
 * which is how a first-view reconcile that outlived its budget reaches an open
 * rail. Renders nothing, and joins nothing, where no realtime client is
 * mounted.
 */
export function BranchCommentsSignalRefresh(
  props: BranchCommentsSignalRefreshProps
) {
  const client = useRealtimeClient();
  return client === null ? null : <OrganizationCommentsChannel {...props} />;
}

function OrganizationCommentsChannel({
  branchId,
  ...subscription
}: BranchCommentsSignalRefreshProps) {
  const currentUser = useCurrentUser();
  const channel = branchCommentsChannel(
    currentUser.data?.organizationId,
    branchId
  );
  return channel === null ? null : (
    <CommentsChannelSubscription channel={channel} {...subscription} />
  );
}

function CommentsChannelSubscription({
  channel,
  dataLoadedAt,
  onCommentsChanged,
}: Omit<BranchCommentsSignalRefreshProps, "branchId"> & { channel: string }) {
  const reload = useCoalescedReload(onCommentsChanged);
  useSignals(channel, {
    types: SignalTypes[ChannelKind.Comments],
    onSignal: reload,
    onResync: reload,
    dataLoadedAt,
  });
  return null;
}

/** `null` where the channel cannot be addressed, e.g. a local branch id. */
function branchCommentsChannel(
  organizationId: string | undefined,
  branchId: string
): string | null {
  if (!organizationId) {
    return null;
  }
  try {
    return formatChannelAddress(ChannelKind.Comments, organizationId, [
      branchId,
    ]);
  } catch {
    return null;
  }
}
