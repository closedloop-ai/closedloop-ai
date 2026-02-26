import { PromptType } from "@repo/api/src/types/prompt";
import {
  computePromptSha256,
  parsePromptFrontmatter,
  parsePromptsSnapshotFromMarkdownEntries,
} from "@/lib/prompt-snapshot-ingestion";

describe("prompt-snapshot-ingestion", () => {
  const MARKDOWN_PROMPT = `---
name: planner
model: claude-opus-4-6
description: Planner agent
tools: bash, read
file_path: prompts/planner.md
---

Plan work carefully.
`;

  describe("parsePromptsSnapshotFromMarkdownEntries", () => {
    it("parses markdown prompt entries into a PromptsSnapshot", () => {
      const snapshot = parsePromptsSnapshotFromMarkdownEntries([
        {
          name: "agents-snapshot/planner.md",
          data: Buffer.from(MARKDOWN_PROMPT, "utf-8"),
        },
      ]);

      expect(snapshot).toEqual({
        prompts: [
          {
            promptType: PromptType.Agent,
            name: "planner",
            description: "Planner agent",
            model: "claude-opus-4-6",
            tools: ["bash", "read"],
            filePath: "prompts/planner.md",
            content: "Plan work carefully.\n",
          },
        ],
      });
    });

    it("returns null when no markdown snapshot entries match", () => {
      const snapshot = parsePromptsSnapshotFromMarkdownEntries([
        {
          name: "plan.json",
          data: Buffer.from('{"content":"# Plan"}', "utf-8"),
        },
      ]);

      expect(snapshot).toBeNull();
    });
  });

  describe("parsePromptFrontmatter", () => {
    it("detects judge prompt type from judges path", () => {
      const judge = parsePromptFrontmatter(
        MARKDOWN_PROMPT,
        "agents-snapshot/judges/planner-judge.md"
      );

      expect(judge?.promptType).toBe(PromptType.Judge);
    });

    it("parses frontmatter when closing delimiter is at EOF without trailing newline", () => {
      const promptWithoutTrailingNewline = `---
name: planner
model: claude-opus-4-6
description: Planner agent
tools: bash, read
---
Plan work carefully.`;
      const parsed = parsePromptFrontmatter(
        promptWithoutTrailingNewline,
        "agents-snapshot/planner.md"
      );

      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe("planner");
      expect(parsed?.model).toBe("claude-opus-4-6");
      expect(parsed?.content).toBe("Plan work carefully.");
    });

    it("parses frontmatter-only file ending with closing delimiter at EOF", () => {
      const frontmatterOnlyWithoutTrailingNewline = `---
name: minimal
model: claude-opus-4-6
---`;
      const parsed = parsePromptFrontmatter(
        frontmatterOnlyWithoutTrailingNewline,
        "agents-snapshot/minimal.md"
      );

      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe("minimal");
      expect(parsed?.content).toBe("");
    });

    it("parses frontmatter with CRLF line endings", () => {
      const crlfPrompt =
        "---\r\nname: crlf-agent\r\nmodel: claude-opus-4-6\r\n---\r\nContent here.";
      const parsed = parsePromptFrontmatter(
        crlfPrompt,
        "agents-snapshot/crlf-agent.md"
      );

      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe("crlf-agent");
      expect(parsed?.content).toBe("Content here.");
    });
  });

  describe("computePromptSha256", () => {
    it("returns stable SHA-256 hex digest for prompt content", () => {
      expect(computePromptSha256("Plan work carefully.\n")).toBe(
        "a022b8daa6de683a4359263cfc176a37b55835b9fd481264fadf2a5f3128799c"
      );
    });

    it("returns different hashes when content differs", () => {
      expect(computePromptSha256("Version A")).not.toBe(
        computePromptSha256("Version B")
      );
    });
  });

  it("returns the normalized snapshot shape from markdown input", () => {
    const snapshot = parsePromptsSnapshotFromMarkdownEntries([
      {
        name: "agents-snapshot/planner.md",
        data: Buffer.from(MARKDOWN_PROMPT, "utf-8"),
      },
    ]);

    expect(snapshot).toEqual({
      prompts: [
        {
          promptType: PromptType.Agent,
          name: "planner",
          description: "Planner agent",
          model: "claude-opus-4-6",
          tools: ["bash", "read"],
          filePath: "prompts/planner.md",
          content: "Plan work carefully.\n",
        },
      ],
    });
  });
});
