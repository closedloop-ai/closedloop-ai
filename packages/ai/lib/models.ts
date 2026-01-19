import { createAnthropic } from "@ai-sdk/anthropic";
import { keys } from "../keys";

const anthropic = createAnthropic({
  apiKey: keys().ANTHROPIC_API_KEY,
});

export const models = {
  opus: anthropic("claude-opus-4-5"),
} as const;
