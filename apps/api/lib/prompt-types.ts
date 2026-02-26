import type { PromptType } from "@repo/database";

export type PromptInfo = {
  promptType: PromptType;
  name: string;
  description: string;
  model: string;
  tools: string[];
  filePath: string;
  content: string;
};

export type PromptsSnapshot = {
  prompts: PromptInfo[];
};
