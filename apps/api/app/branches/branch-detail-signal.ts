import type { TransactionClient } from "@repo/database";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { BranchSignalType } from "@repo/realtime-contract/signals";
import { emitSignal, emitSignals } from "@repo/realtime-server/emit-signal";

/** Commit-coupled invalidation: rolled-back projections never refresh readers. */
export async function emitBranchDetailChanged(
  tx: Pick<TransactionClient, "$executeRaw">,
  organizationId: string,
  branchId: string
): Promise<void> {
  await emitSignal(
    tx,
    formatChannelAddress(ChannelKind.Branches, organizationId, [branchId]),
    {
      type: BranchSignalType.Updated,
      data: { branchId },
    }
  );
}

/** `emitBranchDetailChanged` for several branches in one statement. */
export async function emitBranchDetailsChanged(
  tx: Pick<TransactionClient, "$executeRaw">,
  organizationId: string,
  branchIds: readonly string[]
): Promise<void> {
  await emitSignals(
    tx,
    branchIds.map((branchId) => ({
      channel: formatChannelAddress(ChannelKind.Branches, organizationId, [
        branchId,
      ]),
      signal: { type: BranchSignalType.Updated, data: { branchId } },
    }))
  );
}
