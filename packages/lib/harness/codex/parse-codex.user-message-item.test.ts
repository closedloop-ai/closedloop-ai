import { describe, expect, it } from "vitest";
import { parseCodexRollout } from "./parse-codex";

const SESSION_META = JSON.stringify({
  type: "session_meta",
  timestamp: "2026-10-19T19:29:46.000Z",
  payload: { cwd: "/workspace/proj", cli_version: "0.163.0" },
});
const ENVIRONMENT_CONTEXT =
  "<environment_context>\n  <cwd>/workspace/proj</cwd>\n</environment_context>";
const PROMPT = "Create a PRD for the login page.";
const SECOND_PROMPT = "Continue: add an acceptance criteria section.";

function userResponseItem(text: string): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: "2026-10-19T19:29:47.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function userMessageItem(text: string): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-19T19:29:47.000Z",
    payload: {
      type: "item_completed",
      item: {
        type: "UserMessage",
        id: "16398be2-37bc-75f2-a154-a312fa75b3d0",
        content: [{ type: "text", text }],
      },
    },
  });
}

function userMessageEvent(text: string): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-19T19:29:47.000Z",
    payload: { type: "user_message", message: text },
  });
}

async function parse(lines: string[]) {
  const session = await parseCodexRollout(lines, { sessionId: "codex-0163" });
  if (!session) {
    throw new Error("rollout did not parse");
  }
  return session;
}

function humanTexts(
  session: Awaited<ReturnType<typeof parse>>
): (string | null)[] {
  return session.messages
    .filter((message) => message.role === "human")
    .map((message) => message.text);
}

describe("Codex 0.163 UserMessage items", () => {
  it("count submitted prompts and drop injected context when no user_message event exists", async () => {
    const session = await parse([
      SESSION_META,
      userResponseItem(ENVIRONMENT_CONTEXT),
      userResponseItem(PROMPT),
      userMessageItem(PROMPT),
      userResponseItem(ENVIRONMENT_CONTEXT),
      userResponseItem(SECOND_PROMPT),
      userMessageItem(SECOND_PROMPT),
    ]);

    expect(session.userMessages).toBe(2);
    expect(humanTexts(session)).toEqual([PROMPT, SECOND_PROMPT]);
  });

  it("are not counted again when the rollout also carries user_message events", async () => {
    const session = await parse([
      SESSION_META,
      userResponseItem(ENVIRONMENT_CONTEXT),
      userResponseItem(PROMPT),
      userMessageEvent(PROMPT),
      userMessageItem(PROMPT),
    ]);

    expect(session.userMessages).toBe(1);
    expect(humanTexts(session)).toEqual([PROMPT]);
  });

  it("leave a rollout with neither signal on its response_item messages", async () => {
    const session = await parse([
      SESSION_META,
      userResponseItem(ENVIRONMENT_CONTEXT),
      userResponseItem(PROMPT),
    ]);

    expect(session.userMessages).toBe(2);
  });
});
