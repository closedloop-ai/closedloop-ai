/**
 * Types for agent/judge prompt snapshots extracted from Symphony run artifacts.
 *
 * Prompts are markdown files with YAML frontmatter describing metadata (name,
 * description, model, tools). The promptType distinguishes between agent prompts
 * (general-purpose orchestration/execution agents) and judge prompts (evaluation
 * agents in the agents-snapshot/judges/ subfolder).
 */

/** Discriminates between agent and judge prompt files. */
export const PromptType = {
  AGENT: "AGENT",
  JUDGE: "JUDGE",
} as const;
export type PromptType = (typeof PromptType)[keyof typeof PromptType];

/**
 * Metadata and content for a single agent or judge prompt file.
 *
 * Attributes:
 * - promptType: Whether this is an AGENT or JUDGE prompt
 * - name: Display name from the frontmatter `name` field
 * - description: Short description from the frontmatter `description` field
 * - model: Claude model identifier (e.g., "sonnet", "opus") from frontmatter
 * - tools: List of tool names available to this agent (from frontmatter `tools`)
 * - file_path: Path relative to the workdir (e.g., "agents-snapshot/my-agent.md")
 * - content: Full raw file content including frontmatter
 * - sha: Git blob SHA from the artifact's prompts manifest
 */
export type PromptInfo = {
  promptType: PromptType;
  name: string;
  description: string;
  model: string;
  tools: string[];
  file_path: string;
  content: string;
  sha: string;
};

/**
 * Container for all agent and judge prompts extracted from a Symphony run artifact.
 * Provides a flat list combining both AGENT and JUDGE types.
 */
export type PromptsSnapshot = {
  prompts: PromptInfo[];
};
