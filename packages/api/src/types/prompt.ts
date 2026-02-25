export const PromptType = {
  Agent: "AGENT",
  Judge: "JUDGE",
} as const;

export type PromptType = (typeof PromptType)[keyof typeof PromptType];

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
