/**
 * ISS-12552: Codex 0.163 records a submitted prompt as an `item_completed`
 * event carrying a `UserMessage` item, and no longer writes the
 * `event_msg`/`user_message` record FEA-2641 relies on to tell genuine prompts
 * from injected context. The item plays the same role: it exists only for a
 * prompt the user submitted, never for `<environment_context>`.
 */
import {
  extractText,
  type Rec,
  type RolloutAccumulator,
} from "./codex-accumulator";

export const USER_MESSAGE_ITEM_TYPE = "UserMessage";

export function recordUserMessageItem(
  acc: RolloutAccumulator,
  item: Rec
): void {
  acc.itemUserCount++;
  const key = extractText(item.content).trim();
  if (key) {
    acc.itemUserTexts.set(key, (acc.itemUserTexts.get(key) ?? 0) + 1);
  }
}
