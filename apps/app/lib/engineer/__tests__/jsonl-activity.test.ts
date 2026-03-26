import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLiveActivity } from "../jsonl-activity";

function jsonlLines(...entries: object[]): string {
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

describe("readLiveActivity", () => {
  let TMP_DIR: string;
  let WORK_DIR: string;
  let JSONL_PATH: string;

  beforeEach(async () => {
    TMP_DIR = await mkdtemp(join(tmpdir(), "jsonl-activity-test-"));
    WORK_DIR = join(TMP_DIR, ".closedloop-ai", "work");
    JSONL_PATH = join(WORK_DIR, "claude-output.jsonl");
    await mkdir(WORK_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("returns undefined when JSONL file does not exist", async () => {
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty file", async () => {
    await writeFile(JSONL_PATH, "");
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBeUndefined();
  });

  it("parses single-line file correctly (offset === 0)", async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", id: "t1", input: {} }],
        },
      })
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Reading files...");
  });

  it('returns "Reading files..." for assistant with Read tool_use', async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines(
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Read", id: "t1", input: {} }],
          },
        }
      )
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Reading files...");
  });

  it('returns "Searching codebase..." for Grep tool', async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Grep", id: "t1", input: {} }],
        },
      })
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Searching codebase...");
  });

  it('returns "Working..." for unknown tool name', async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "SomeFutureTool", id: "t1", input: {} },
          ],
        },
      })
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Working...");
  });

  it('returns "Analyzing..." for thinking block', async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines({
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Let me think..." }],
        },
      })
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Analyzing...");
  });

  it('returns "Processing..." for text block', async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Here is my analysis" }],
        },
      })
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Processing...");
  });

  it('returns "Processing tool results..." for user tool_result entry', async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file data" },
          ],
        },
      })
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Processing tool results...");
  });

  it('returns "Working..." for progress entry', async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines({ type: "progress", data: { subtype: "tick" } })
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Working...");
  });

  it('returns "Working..." for queue-operation entry', async () => {
    await writeFile(JSONL_PATH, jsonlLines({ type: "queue-operation" }));
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Working...");
  });

  it("skips entries with parentToolUseId (subagent noise)", async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines(
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Grep", id: "t1", input: {} }],
          },
        },
        {
          type: "assistant",
          parent_tool_use_id: "sub-1",
          message: {
            content: [{ type: "tool_use", name: "Read", id: "t2", input: {} }],
          },
        }
      )
    );
    const result = await readLiveActivity(TMP_DIR);
    // Should skip the subagent Read and return the parent Grep
    expect(result).toBe("Searching codebase...");
  });

  it("handles malformed JSONL lines without crashing", async () => {
    await writeFile(
      JSONL_PATH,
      "{broken json\n" +
        jsonlLines({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "hello" }],
          },
        })
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Processing...");
  });

  it("skips file-history-snapshot entries", async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines(
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Edit", id: "t1", input: {} }],
          },
        },
        { type: "file-history-snapshot" }
      )
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Editing files...");
  });

  it("skips real user prompts (non-tool_result)", async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines(
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Done." }],
          },
        },
        {
          type: "user",
          message: { role: "user", content: "Tell me more" },
        }
      )
    );
    const result = await readLiveActivity(TMP_DIR);
    // Should skip the user prompt and return the assistant entry
    expect(result).toBe("Processing...");
  });

  it("handles large file with truncated first line", async () => {
    // Create a file larger than 64KB (READ_WINDOW) to trigger the offset > 0 path
    const padding = `${"x".repeat(65 * 1024)}\n`;
    const entries = jsonlLines({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Write", id: "t1", input: {} }],
      },
    });
    await writeFile(JSONL_PATH, padding + entries);
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBe("Writing files...");
  });

  it("returns undefined when all entries are subagent", async () => {
    await writeFile(
      JSONL_PATH,
      jsonlLines(
        {
          type: "assistant",
          parent_tool_use_id: "sub-1",
          message: {
            content: [{ type: "tool_use", name: "Read", id: "t1", input: {} }],
          },
        },
        {
          type: "assistant",
          parent_tool_use_id: "sub-2",
          message: {
            content: [{ type: "text", text: "sub work" }],
          },
        }
      )
    );
    const result = await readLiveActivity(TMP_DIR);
    expect(result).toBeUndefined();
  });

  describe("legacy-aware path fallback", () => {
    it("JSONL at old .claude/work path only -> returns activity label", async () => {
      // Clean up the standard new-path work dir created in beforeEach
      await rm(WORK_DIR, { recursive: true, force: true });

      const oldWorkDir = join(TMP_DIR, ".claude", "work");
      await mkdir(oldWorkDir, { recursive: true });
      await writeFile(
        join(oldWorkDir, "claude-output.jsonl"),
        jsonlLines({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Read", id: "t1", input: {} }],
          },
        })
      );

      const result = await readLiveActivity(TMP_DIR);
      expect(result).toBe("Reading files...");
    });

    it("JSONL at new .closedloop-ai/work path only -> returns activity label", async () => {
      await writeFile(
        JSONL_PATH,
        jsonlLines({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Grep", id: "t1", input: {} }],
          },
        })
      );

      const result = await readLiveActivity(TMP_DIR);
      expect(result).toBe("Searching codebase...");
    });
  });
});
