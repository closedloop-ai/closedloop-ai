import { z } from "zod";

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string(),
  blocks: z.array(z.unknown()).optional(),
});

export const createGenericChatValidator = z.object({
  chatKey: z.string().min(1).max(500),
  provider: z.enum(["claude", "codex"]),
  model: z.string().min(1).max(200),
  context: z.string().max(50_000).optional(),
  messages: z.array(chatMessageSchema).default([]),
});

export const appendMessagesValidator = z.object({
  chatKey: z.string().min(1).max(500),
  provider: z.enum(["claude", "codex"]),
  messages: z.array(chatMessageSchema).min(1),
  sessionId: z.string().optional(),
});

export const turnValidator = z.object({
  chatKey: z.string().min(1).max(500),
  userMessage: chatMessageSchema.refine((m) => m.role === "user", {
    message: "userMessage.role must be 'user'",
  }),
  provider: z.enum(["claude", "codex"]),
  model: z.string().min(1).max(200),
  context: z.string().max(50_000).optional(),
  sourceGatewayId: z.string().min(1),
});

export const completeTurnValidator = z
  .object({
    chatKey: z.string().min(1).max(500),
    provider: z.enum(["claude", "codex"]),
    messages: z.array(chatMessageSchema).min(1),
    sessionId: z.string().nullable(),
    sessionSourceId: z.string().nullable(),
  })
  .refine(
    (data) =>
      (data.sessionId === null && data.sessionSourceId === null) ||
      (data.sessionId !== null && data.sessionSourceId !== null),
    {
      message:
        "sessionId and sessionSourceId must both be null or both be non-null",
    }
  );
