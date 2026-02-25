import { PromptType } from "@repo/api/src/types/prompt";
import {
  parsePromptFrontmatter,
  parsePromptsSnapshotFromJson,
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

  describe("parsePromptsSnapshotFromJson", () => {
    it("maps file_path to filePath from legacy JSON artifact", () => {
      const snapshot = parsePromptsSnapshotFromJson(
        Buffer.from(
          JSON.stringify({
            prompts: [
              {
                promptType: "AGENT",
                name: "planner",
                description: "Planner agent",
                model: "claude-opus-4-6",
                tools: ["bash", "read"],
                file_path: "prompts/planner.md",
                content: "Plan work carefully.\n",
              },
            ],
          }),
          "utf-8"
        )
      );

      expect(snapshot?.prompts[0].filePath).toBe("prompts/planner.md");
      expect(
        (snapshot?.prompts[0] as unknown as Record<string, unknown>).file_path
      ).toBeUndefined();
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
  });

  it("produces equivalent normalized shape for markdown and JSON inputs", () => {
    const fromMarkdown = parsePromptsSnapshotFromMarkdownEntries([
      {
        name: "agents-snapshot/planner.md",
        data: Buffer.from(MARKDOWN_PROMPT, "utf-8"),
      },
    ]);

    const fromJson = parsePromptsSnapshotFromJson(
      Buffer.from(
        JSON.stringify({
          prompts: [
            {
              promptType: "AGENT",
              name: "planner",
              description: "Planner agent",
              model: "claude-opus-4-6",
              tools: ["bash", "read"],
              file_path: "prompts/planner.md",
              content: "Plan work carefully.\n",
            },
          ],
        }),
        "utf-8"
      )
    );

    expect(fromMarkdown).toEqual(fromJson);
  });
});
