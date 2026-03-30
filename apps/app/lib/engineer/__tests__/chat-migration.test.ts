/**
 * Tests for global chat history migration precedence.
 *
 * The three chat routes (terminal-chat, run-viewer-chat, ticket-chat) share
 * the same three-tier precedence for their chat history files:
 *
 *   1. New path  (~/.closedloop-ai/chats/...)         — wins if present
 *   2. Closedloop path (~/.claude/.closedloop/chats/...)  — migrated if (1) absent
 *   3. Legacy path (~/.claude/.symphony/chats/...)      — migrated if (1)+(2) absent
 *
 * Because loadChatHistory is not exported from the route files, we test the
 * underlying migrateLegacyChatHistory helper directly and verify the path
 * resolution logic that the routes implement.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyChatHistory } from "@/lib/engineer/migrate-chat-history";

/** Simulates loadChatHistory precedence logic used by terminal-chat and run-viewer-chat. */
function simulateLoadGlobalChat(
  base: string,
  chatKey: string
): { messages: unknown[]; source: string } {
  const newPath = join(
    base,
    ".closedloop-ai",
    "chats",
    chatKey,
    "chat-history.json"
  );
  const closedloopPath = join(
    base,
    ".claude",
    ".closedloop",
    "chats",
    chatKey,
    "chat-history.json"
  );
  const legacyPath = join(
    base,
    ".claude",
    ".symphony",
    "chats",
    chatKey,
    "chat-history.json"
  );

  if (existsSync(newPath)) {
    // already at new location — no migration needed
  } else if (existsSync(closedloopPath)) {
    migrateLegacyChatHistory(closedloopPath, newPath);
  } else if (existsSync(legacyPath)) {
    migrateLegacyChatHistory(legacyPath, newPath);
  }

  if (!existsSync(newPath)) {
    return { messages: [], source: "empty" };
  }
  try {
    const content = JSON.parse(readFileSync(newPath, "utf-8")) as {
      messages: unknown[];
    };
    return { messages: content.messages, source: newPath };
  } catch {
    return { messages: [], source: "parse-error" };
  }
}

/** Simulates loadChatHistory precedence for ticket-chat (uses sanitized ticketId). */
function simulateLoadTicketChat(
  base: string,
  ticketId: string
): { messages: unknown[]; source: string } {
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  return simulateLoadGlobalChat(base, sanitizedTicket);
}

describe("chat history migration precedence", () => {
  let testBase: string;

  beforeEach(() => {
    testBase = mkdtempSync(join(tmpdir(), "chat-migration-test-"));
  });

  afterEach(() => {
    rmSync(testBase, { recursive: true, force: true });
  });

  describe("terminal-chat and run-viewer-chat style loadChatHistory", () => {
    const CHAT_KEY = "_terminal";

    it("only .symphony (legacy) exists -> migrated to new path", () => {
      const legacyPath = join(
        testBase,
        ".claude",
        ".symphony",
        "chats",
        CHAT_KEY,
        "chat-history.json"
      );
      mkdirSync(join(legacyPath, ".."), { recursive: true });
      writeFileSync(legacyPath, JSON.stringify({ messages: [{ id: "1" }] }));

      const result = simulateLoadGlobalChat(testBase, CHAT_KEY);

      expect(result.messages).toHaveLength(1);
      // Legacy file was deleted after migration
      expect(existsSync(legacyPath)).toBe(false);
      // New path now has the data
      const newPath = join(
        testBase,
        ".closedloop-ai",
        "chats",
        CHAT_KEY,
        "chat-history.json"
      );
      expect(existsSync(newPath)).toBe(true);
    });

    it("only .closedloop path exists -> migrated to new path", () => {
      const closedloopPath = join(
        testBase,
        ".claude",
        ".closedloop",
        "chats",
        CHAT_KEY,
        "chat-history.json"
      );
      mkdirSync(join(closedloopPath, ".."), { recursive: true });
      writeFileSync(
        closedloopPath,
        JSON.stringify({ messages: [{ id: "cl-1" }] })
      );

      const result = simulateLoadGlobalChat(testBase, CHAT_KEY);

      expect(result.messages).toHaveLength(1);
      expect(existsSync(closedloopPath)).toBe(false);
    });

    it("both .closedloop and .symphony exist -> .closedloop wins (migrated first)", () => {
      const closedloopPath = join(
        testBase,
        ".claude",
        ".closedloop",
        "chats",
        CHAT_KEY,
        "chat-history.json"
      );
      const legacyPath = join(
        testBase,
        ".claude",
        ".symphony",
        "chats",
        CHAT_KEY,
        "chat-history.json"
      );
      mkdirSync(join(closedloopPath, ".."), { recursive: true });
      mkdirSync(join(legacyPath, ".."), { recursive: true });
      writeFileSync(
        closedloopPath,
        JSON.stringify({ messages: [{ id: "closedloop" }] })
      );
      writeFileSync(
        legacyPath,
        JSON.stringify({ messages: [{ id: "legacy" }, { id: "legacy2" }] })
      );

      const result = simulateLoadGlobalChat(testBase, CHAT_KEY);

      // .closedloop data wins
      expect(result.messages).toHaveLength(1);
      expect((result.messages[0] as { id: string }).id).toBe("closedloop");
    });

    it("new path already exists -> no migration, reads directly", () => {
      const newPath = join(
        testBase,
        ".closedloop-ai",
        "chats",
        CHAT_KEY,
        "chat-history.json"
      );
      mkdirSync(join(newPath, ".."), { recursive: true });
      writeFileSync(newPath, JSON.stringify({ messages: [{ id: "new" }] }));

      const legacyPath = join(
        testBase,
        ".claude",
        ".symphony",
        "chats",
        CHAT_KEY,
        "chat-history.json"
      );
      mkdirSync(join(legacyPath, ".."), { recursive: true });
      writeFileSync(
        legacyPath,
        JSON.stringify({ messages: [{ id: "should-not-win" }] })
      );

      const result = simulateLoadGlobalChat(testBase, CHAT_KEY);

      expect(result.messages).toHaveLength(1);
      expect((result.messages[0] as { id: string }).id).toBe("new");
      // Legacy file left intact (no migration ran)
      expect(existsSync(legacyPath)).toBe(true);
    });

    it("no history file in any location -> returns empty messages", () => {
      const result = simulateLoadGlobalChat(testBase, CHAT_KEY);
      expect(result.messages).toHaveLength(0);
    });
  });

  describe("ticket-chat loadChatHistory with sanitized ticketId", () => {
    it("sanitizes ticket ID path (slashes become underscores)", () => {
      const ticketId = "AI/123";
      const sanitized = "AI_123";

      const legacyPath = join(
        testBase,
        ".claude",
        ".symphony",
        "chats",
        sanitized,
        "chat-history.json"
      );
      mkdirSync(join(legacyPath, ".."), { recursive: true });
      writeFileSync(legacyPath, JSON.stringify({ messages: [{ id: "t1" }] }));

      const result = simulateLoadTicketChat(testBase, ticketId);

      expect(result.messages).toHaveLength(1);
    });

    it("only .symphony path exists -> migrated", () => {
      const ticketId = "AI-100";
      const legacyPath = join(
        testBase,
        ".claude",
        ".symphony",
        "chats",
        ticketId,
        "chat-history.json"
      );
      mkdirSync(join(legacyPath, ".."), { recursive: true });
      writeFileSync(
        legacyPath,
        JSON.stringify({ messages: [{ id: "ai100" }] })
      );

      const result = simulateLoadTicketChat(testBase, ticketId);
      expect(result.messages).toHaveLength(1);
    });

    it("only .closedloop path exists -> migrated", () => {
      const ticketId = "AI-200";
      const closedloopPath = join(
        testBase,
        ".claude",
        ".closedloop",
        "chats",
        ticketId,
        "chat-history.json"
      );
      mkdirSync(join(closedloopPath, ".."), { recursive: true });
      writeFileSync(
        closedloopPath,
        JSON.stringify({ messages: [{ id: "ai200" }] })
      );

      const result = simulateLoadTicketChat(testBase, ticketId);
      expect(result.messages).toHaveLength(1);
    });

    it("both exist -> .closedloop wins", () => {
      const ticketId = "AI-300";
      const closedloopPath = join(
        testBase,
        ".claude",
        ".closedloop",
        "chats",
        ticketId,
        "chat-history.json"
      );
      const legacyPath = join(
        testBase,
        ".claude",
        ".symphony",
        "chats",
        ticketId,
        "chat-history.json"
      );
      mkdirSync(join(closedloopPath, ".."), { recursive: true });
      mkdirSync(join(legacyPath, ".."), { recursive: true });
      writeFileSync(
        closedloopPath,
        JSON.stringify({ messages: [{ id: "cl300" }] })
      );
      writeFileSync(
        legacyPath,
        JSON.stringify({ messages: [{ id: "leg300" }, { id: "leg300b" }] })
      );

      const result = simulateLoadTicketChat(testBase, ticketId);
      expect(result.messages).toHaveLength(1);
      expect((result.messages[0] as { id: string }).id).toBe("cl300");
    });

    it("new path exists -> no migration", () => {
      const ticketId = "AI-400";
      const newPath = join(
        testBase,
        ".closedloop-ai",
        "chats",
        ticketId,
        "chat-history.json"
      );
      mkdirSync(join(newPath, ".."), { recursive: true });
      writeFileSync(newPath, JSON.stringify({ messages: [{ id: "new400" }] }));

      const legacyPath = join(
        testBase,
        ".claude",
        ".symphony",
        "chats",
        ticketId,
        "chat-history.json"
      );
      mkdirSync(join(legacyPath, ".."), { recursive: true });
      writeFileSync(
        legacyPath,
        JSON.stringify({ messages: [{ id: "old400" }] })
      );

      const result = simulateLoadTicketChat(testBase, ticketId);
      expect((result.messages[0] as { id: string }).id).toBe("new400");
      expect(existsSync(legacyPath)).toBe(true);
    });
  });
});
