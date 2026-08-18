/**
 * Gateway chat-route request/response fixtures, shared by the gateway server
 * tests. Extracted from gateway-server.test.ts (ISS-5114) to keep that
 * grandfathered file shrinking rather than growing — see AGENTS.md
 * "File Size and Organization".
 */

export function buildChatSessionRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "chat-1",
    chatKey: "chat-key-1",
    provider: "claude",
    model: "claude-sonnet-4-5",
    context: null,
    messages: [
      {
        id: "u1",
        role: "user",
        content: "hi",
        timestamp: "2026-06-17T00:00:00.000Z",
      },
    ],
    sessionId: null,
    sessionSourceId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

export function buildGatewayChatPayload(): Record<string, unknown> {
  return {
    chatKey: "chat-key-1",
    userMessage: {
      id: "u1",
      role: "user",
      content: "hi",
      timestamp: "2026-06-17T00:00:00.000Z",
    },
    provider: "claude",
    apiBaseUrl: "https://api.example.test",
    apiAuthToken: "token-xyz",
  };
}
