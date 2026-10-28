"use client";

import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import {
  type CommentThreadSignalData,
  SignalTypes,
} from "@repo/realtime-contract/signals";
import { useMemo } from "react";
import { useSignals } from "../realtime/use-signals";

export type CommentEventStreamOptions = {
  /** The viewer's organization; the host reads it (`shared/` imports no feature slice). */
  organizationId: string | null | undefined;
  /** Unknown until the collection's first read names it. */
  artifactId: string | null | undefined;
  onThreadSignal: (data: CommentThreadSignalData) => void;
  onResync: () => void;
  dataLoadedAt: () => number | undefined;
  /** Runs only while the channel is not live, and until the channel is known. */
  poll: () => Promise<void>;
};

/**
 * PLN-2162 M2.4: joins `comments:{orgId}:{artifactId}` for as long as a
 * comment surface is mounted. Until both ids are known it only polls.
 */
export function useCommentEventStream({
  organizationId,
  artifactId,
  onThreadSignal,
  onResync,
  dataLoadedAt,
  poll,
}: CommentEventStreamOptions): void {
  const channel = useMemo(
    () => commentsChannel(organizationId, artifactId),
    [organizationId, artifactId]
  );
  useSignals(channel, {
    types: SignalTypes[ChannelKind.Comments],
    onSignal: (signal) => onThreadSignal(signal.data),
    onResync,
    dataLoadedAt,
    poll,
  });
}

/** The artifact's comments channel, or null when either id cannot form one. */
export function commentsChannel(
  organizationId: string | null | undefined,
  artifactId: string | null | undefined
): string | null {
  if (!(organizationId && artifactId)) {
    return null;
  }
  try {
    return formatChannelAddress(ChannelKind.Comments, organizationId, [
      artifactId,
    ]);
  } catch {
    // An id the channel grammar refuses: the surface keeps polling instead.
    return null;
  }
}
