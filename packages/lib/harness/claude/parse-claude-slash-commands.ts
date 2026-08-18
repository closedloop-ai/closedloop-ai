/**
 * @file parse-claude-slash-commands.ts
 * @description Recording a slash-command invocation found in a record's text.
 *
 * Lives in its own module because BOTH text-bearing lanes scan for commands and
 * they must scan identically: the harness writes a `<command-name>` marker into
 * the user turn that invoked it AND, on expansion or replay, into the assistant
 * text that echoes it. A rewrite that ported only the user lane silently dropped
 * every assistant-side invocation along with the definition snapshot keyed to
 * it, which is why the two callers now share one copy rather than each holding
 * their own.
 */
import { stringValue } from "../parser-utils";
import type { SessionAccumulator } from "./parse-claude-accumulator";
import { findSlashCommandInvocations } from "./slash-command-invocation";

/**
 * Record every slash command named in `text` against the turn that carried it.
 *
 * The turn id is what a later `isMeta` definition record joins on to attach its
 * snapshot, so a command recorded without one can never be given its definition.
 */
export function collectSlashCommands(
  record: Record<string, unknown>,
  text: string,
  timestamp: string | null,
  accumulator: SessionAccumulator
): void {
  if (!timestamp) {
    return;
  }
  const userTurnId = stringValue(record.promptId) ?? stringValue(record.uuid);
  for (const invocation of findSlashCommandInvocations(text)) {
    const index = accumulator.slashCommands.length;
    accumulator.slashCommands.push({
      name: invocation.name,
      timestamp,
      ...(userTurnId ? { userTurnId } : {}),
    });
    if (userTurnId) {
      accumulator.slashCommandIndexByTurnId.set(userTurnId, index);
    }
  }
}
