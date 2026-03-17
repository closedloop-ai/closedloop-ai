import { LoopCommand } from "@repo/api/src/types/loop";
import { decomposeHandler } from "./decompose-handler";
import { evaluatePrdHandler } from "./evaluate-prd-handler";
import { executeHandler } from "./execute-handler";
import type { LoopCommandHandler } from "./loop-command-handler";
import { planHandler, requestChangesHandler } from "./plan-handler";

export type { LoopCommandHandler } from "./loop-command-handler";

export function getCommandHandler(
  command: LoopCommand
): LoopCommandHandler | undefined {
  return COMMAND_HANDLERS[command];
}

const COMMAND_HANDLERS: Record<LoopCommand, LoopCommandHandler | undefined> = {
  [LoopCommand.Plan]: planHandler,
  [LoopCommand.RequestChanges]: requestChangesHandler,
  [LoopCommand.Execute]: executeHandler,
  [LoopCommand.Chat]: undefined,
  [LoopCommand.Explore]: undefined,
  [LoopCommand.Decompose]: decomposeHandler,
  [LoopCommand.EvaluatePrd]: evaluatePrdHandler,
};
