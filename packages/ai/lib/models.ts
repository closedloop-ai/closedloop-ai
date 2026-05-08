import { createAnthropic } from "@ai-sdk/anthropic";
import { keys } from "../keys";

// Lazy initialization to avoid validating env vars at module load time
let _anthropic: ReturnType<typeof createAnthropic> | null = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = createAnthropic({
      apiKey: keys().ANTHROPIC_API_KEY,
    });
  }
  return _anthropic;
}

export const models = {
  get opus() {
    return getAnthropic()("claude-opus-4-5");
  },
  get sonnet() {
    return getAnthropic()("claude-sonnet-4-6");
  },
} as const;
