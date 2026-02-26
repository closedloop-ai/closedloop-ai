// Prompt types for API contract (shared frontend/backend).
// String union avoids Prisma dependency in parsers and API types.

export type PromptType = "AGENT" | "JUDGE";

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
