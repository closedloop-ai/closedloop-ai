import { describe, expect, it } from "vitest";
import { readChatStream } from "../chat-utils";
import { readTerminalStream } from "../terminal-stream";
import { createReader } from "./test-helpers";

describe("stream readers", () => {
  it("parses terminal events when JSON lines are split across chunks", async () => {
    const reader = createReader([
      '{"type":"status","status":"running"}\n{"type":"te',
      'xt","content":"hel',
      'lo"}\n{"type":"done"}\n',
    ]);

    const statuses: string[] = [];
    let text = "";
    let completed = 0;

    await readTerminalStream(reader, {
      onText: (content) => {
        text = content;
      },
      onClear: () => {},
      onError: () => {},
      onComplete: () => {
        completed += 1;
      },
      onStatus: (status) => {
        statuses.push(status);
      },
    });

    expect(statuses).toContain("running");
    expect(text).toBe("hello");
    expect(completed).toBe(1);
  });

  it("parses chat events with split chunks and trailing line without newline", async () => {
    const reader = createReader([
      '{"type":"text","content":"hel',
      'lo"}\n{"type":"text","content":" world"}\n{"type":"done"}',
    ]);

    let text = "";
    let completed = 0;

    await readChatStream(reader, {
      onText: (content) => {
        text = content;
      },
      onError: () => {},
      onComplete: () => {
        completed += 1;
      },
    });

    expect(text).toBe("hello world");
    expect(completed).toBe(1);
  });
});
