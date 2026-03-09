import { LoopCommand } from "@repo/api/src/types/loop";
import { executeHandler } from "./execute-handler";
import type { LoopCommandHandler } from "./loop-command-handler";
import { planHandler, requestChangesHandler } from "./plan-handler";

export type { LoopCommandHandler } from "./loop-command-handler";

export function getCommandHandler(
  command: LoopCommand
): LoopCommandHandler | undefined {
  return COMMAND_HANDLERS[command];
}

const defaultCommandHandler: LoopCommandHandler = {
  requiresRepo: false,
  requiresParent: false,
  includePrimaryArtifact: false,
  downloadAndIngest() {
    throw new Error("Command does not support artifact ingestion.");
  },
};

const COMMAND_HANDLERS: Record<LoopCommand, LoopCommandHandler> = {
  [LoopCommand.Plan]: planHandler,
  [LoopCommand.RequestChanges]: requestChangesHandler,
  [LoopCommand.Execute]: executeHandler,
  [LoopCommand.Chat]: defaultCommandHandler,
  [LoopCommand.Explore]: defaultCommandHandler,
};
