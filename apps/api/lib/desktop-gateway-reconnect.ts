import { isDesktopApiPath } from "@repo/api/src/desktop-api-namespace";

export type ReconnectPendingCommand = {
  commandId: string;
  computeTargetId: string;
  path: string;
};

export type PartitionedPendingCommands<T extends ReconnectPendingCommand> = {
  emit: T[];
  skipped: T[];
};

export function partitionPendingCommandsForReconnect<
  T extends ReconnectPendingCommand,
>(commands: readonly T[]): PartitionedPendingCommands<T> {
  const emit: T[] = [];
  const skipped: T[] = [];
  for (const command of commands) {
    if (isDesktopApiPath(command.path)) {
      emit.push(command);
    } else {
      skipped.push(command);
    }
  }
  return { emit, skipped };
}
