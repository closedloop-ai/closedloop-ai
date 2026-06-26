import type { ChatMessage } from "@repo/api/src/types/chat-session";
import { Result } from "@repo/api/src/types/result";
import { type ChatSession, type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string(),
  blocks: z.array(z.unknown()).optional(),
});

const chatMessagesSchema = z.array(chatMessageSchema);

/**
 * Narrowing helpers for the `messages` JSON column. The Prisma client
 * types the column as `Prisma.JsonValue` on read and requires
 * `Prisma.InputJsonValue` on write, so every read/write historically
 * needed a `as unknown as ChatMessage[] as never` chain. Centralize
 * that coercion here so the service bodies stay clean.
 */
function toPrismaJsonMessages(messages: ChatMessage[]): Prisma.InputJsonValue {
  const parsed = chatMessagesSchema.safeParse(messages);
  if (!parsed.success) {
    log.error("Invalid chat messages before persistence", {
      error: parsed.error.flatten(),
    });
    throw new Error("Invalid chat messages before persistence");
  }
  return parsed.data as Prisma.InputJsonValue;
}

function parseStoredMessages(
  raw: Prisma.JsonValue | null | undefined
): ChatMessage[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  const parsed = chatMessagesSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn("Invalid stored chat messages", {
      error: parsed.error.flatten(),
    });
    return [];
  }
  return parsed.data;
}

export type CreateChatSessionInput = {
  userId: string;
  organizationId: string;
  chatKey: string;
  provider: string;
  model: string;
  context?: string;
  messages?: ChatMessage[];
};

export type CreateChatSessionError = {
  kind: "providerConflict";
  boundProvider: string;
};
export type CreateChatSessionValue = { chat: ChatSession };
export type CreateChatSessionResult = Result<
  CreateChatSessionValue,
  CreateChatSessionError
>;

export type AppendMessagesError =
  | { kind: "notFound" }
  | { kind: "providerConflict"; boundProvider: string };
export type AppendMessagesValue = { chat: ChatSession };
export type AppendMessagesResult = Result<
  AppendMessagesValue,
  AppendMessagesError
>;

export type TurnInput = {
  chatKey: string;
  userMessage: ChatMessage;
  provider: string;
  model: string;
  context?: string;
  sourceGatewayId: string;
};

export type UpsertTurnError = {
  kind: "providerConflict";
  boundProvider: string;
};
export type UpsertTurnValue = {
  chat: ChatSession;
  resumeSessionId: string | null;
};
export type UpsertTurnResult = Result<UpsertTurnValue, UpsertTurnError>;

export type CompleteTurnInput = {
  chatKey: string;
  provider: string;
  messages: ChatMessage[];
  sessionId: string | null;
  sessionSourceId: string | null;
};

export type AppendAssistantTurnError =
  | { kind: "notFound" }
  | { kind: "providerConflict"; boundProvider: string };
export type AppendAssistantTurnValue = { chat: ChatSession };
export type AppendAssistantTurnResult = Result<
  AppendAssistantTurnValue,
  AppendAssistantTurnError
>;

/**
 * Service for `chat_sessions` DB operations. All read/update operations are
 * scoped by (userId, chatKey) so cross-user access is impossible at the
 * query level. `organizationId` is accepted only by methods that create new
 * rows (`create`, `upsertTurn`) because those are the only operations that
 * need to stamp it on new records; read/append/delete paths derive isolation
 * purely from `userId`. `create` and `appendMessages` run inside `withDb.tx`
 * so the read-then-write merge is atomic against concurrent writers.
 */
export const chatSessionsService = {
  /**
   * Find a chat by (userId, chatKey). Returns null when the row does not
   * exist or belongs to a different user. Plain `withDb` is sufficient —
   * no read-after-write coordination is required.
   */
  findByKey(userId: string, chatKey: string): Promise<ChatSession | null> {
    return withDb((db) =>
      db.chatSession.findUnique({
        where: { userId_chatKey: { userId, chatKey } },
      })
    );
  },

  /**
   * Create a new chat, or reconcile messages into an existing row when
   * (userId, chatKey) already exists. Reconciliation is id-based: only
   * messages whose id is not already stored are appended; existing order
   * is preserved and new ids go at the end. Returns `{ chat }` on success
   * or `{ conflict, boundProvider }` when the existing row was created
   * with a different provider (provider is immutable per chat). Runs
   * inside a transaction so concurrent creates cannot produce duplicate
   * message ids.
   */
  create(data: CreateChatSessionInput): Promise<CreateChatSessionResult> {
    const {
      userId,
      organizationId,
      chatKey,
      provider,
      model,
      context,
      messages,
    } = data;
    const incoming = messages ?? [];

    return withDb.tx(async (tx) => {
      const existing = await tx.chatSession.findUnique({
        where: { userId_chatKey: { userId, chatKey } },
      });

      if (!existing) {
        const created = await tx.chatSession.create({
          data: {
            userId,
            organizationId,
            chatKey,
            provider,
            model,
            context: context ?? null,
            messages: toPrismaJsonMessages(incoming),
          },
        });
        log.info("Chat session created", {
          chatId: created.id,
          userId,
          chatKey,
          provider,
        });
        return Result.ok<CreateChatSessionValue, CreateChatSessionError>({
          chat: created,
        });
      }

      if (existing.provider !== provider) {
        return Result.err<CreateChatSessionValue, CreateChatSessionError>({
          kind: "providerConflict",
          boundProvider: existing.provider,
        });
      }

      const toAppend = filterNewMessages(
        incoming,
        parseStoredMessages(existing.messages)
      );

      if (toAppend.length === 0) {
        return Result.ok<CreateChatSessionValue, CreateChatSessionError>({
          chat: existing,
        });
      }

      const mergedMessages = [
        ...parseStoredMessages(existing.messages),
        ...toAppend,
      ];

      const updated = await tx.chatSession.update({
        where: { userId_chatKey: { userId, chatKey } },
        data: {
          messages: toPrismaJsonMessages(mergedMessages),
        },
      });
      return Result.ok<CreateChatSessionValue, CreateChatSessionError>({
        chat: updated,
      });
    });
  },

  /**
   * Append messages and optionally update sessionId on an existing chat.
   * Id-idempotent: messages whose id already exists in the stored row are
   * silently skipped. Returns `{ notFound }` when the row does not exist
   * or belongs to a different user, `{ conflict, boundProvider }` when the
   * provider does not match the stored provider, or `{ chat }` otherwise.
   * When there is nothing to write (all ids already present and sessionId
   * unchanged), returns the existing row without bumping `updatedAt`.
   */
  appendMessages(
    userId: string,
    chatKey: string,
    provider: string,
    messagesToAppend: ChatMessage[],
    sessionId?: string
  ): Promise<AppendMessagesResult> {
    return withDb.tx(async (tx) => {
      const existing = await tx.chatSession.findUnique({
        where: { userId_chatKey: { userId, chatKey } },
      });

      if (!existing) {
        return Result.err<AppendMessagesValue, AppendMessagesError>({
          kind: "notFound",
        });
      }

      if (existing.provider !== provider) {
        return Result.err<AppendMessagesValue, AppendMessagesError>({
          kind: "providerConflict",
          boundProvider: existing.provider,
        });
      }

      const existingMessages = parseStoredMessages(existing.messages);
      const toAppend = filterNewMessages(messagesToAppend, existingMessages);
      const sessionIdChanged =
        sessionId !== undefined && sessionId !== existing.sessionId;

      if (toAppend.length === 0 && !sessionIdChanged) {
        return Result.ok<AppendMessagesValue, AppendMessagesError>({
          chat: existing,
        });
      }

      const mergedMessages = [...existingMessages, ...toAppend];

      const updated = await tx.chatSession.update({
        where: { userId_chatKey: { userId, chatKey } },
        data: {
          messages: toPrismaJsonMessages(mergedMessages),
          ...(sessionIdChanged ? { sessionId } : {}),
        },
      });
      return Result.ok<AppendMessagesValue, AppendMessagesError>({
        chat: updated,
      });
    });
  },

  /**
   * Hard delete a chat row. Idempotent: returns `true` when the row was
   * deleted, `false` when no row existed. `deleteMany` scoped to
   * (userId, chatKey) guarantees cross-user rows cannot be deleted.
   */
  async deleteChat(userId: string, chatKey: string): Promise<boolean> {
    const result = await withDb((db) =>
      db.chatSession.deleteMany({
        where: { userId, chatKey },
      })
    );
    return result.count > 0;
  },

  /**
   * Record a user turn: create the chat if absent, or id-idempotently
   * append the incoming user message to the existing row. Enforces the
   * provider lock and derives `resumeSessionId` from whether the stored
   * session belongs to the calling gateway. Never writes `sessionId` or
   * `sessionSourceId` — those are owned by `appendAssistantTurn`.
   */
  upsertTurn(
    userId: string,
    organizationId: string,
    input: TurnInput
  ): Promise<UpsertTurnResult> {
    return withDb.tx(async (tx) => {
      const existing = await tx.chatSession.findUnique({
        where: { userId_chatKey: { userId, chatKey: input.chatKey } },
      });

      let row: ChatSession;

      if (existing) {
        if (existing.provider !== input.provider) {
          return Result.err<UpsertTurnValue, UpsertTurnError>({
            kind: "providerConflict",
            boundProvider: existing.provider,
          });
        }

        const existingMessages = parseStoredMessages(existing.messages);
        const alreadyStored = existingMessages.some(
          (m) => m.id === input.userMessage.id
        );

        if (alreadyStored) {
          row = existing;
        } else {
          const mergedMessages = [...existingMessages, input.userMessage];
          row = await tx.chatSession.update({
            where: { userId_chatKey: { userId, chatKey: input.chatKey } },
            data: {
              messages: toPrismaJsonMessages(mergedMessages),
            },
          });
        }
      } else {
        row = await tx.chatSession.create({
          data: {
            userId,
            organizationId,
            chatKey: input.chatKey,
            provider: input.provider,
            model: input.model,
            context: input.context ?? null,
            messages: toPrismaJsonMessages([input.userMessage]),
            sessionId: null,
            sessionSourceId: null,
          },
        });
        log.info("Chat session created via upsertTurn", {
          chatId: row.id,
          userId,
          chatKey: input.chatKey,
          provider: input.provider,
        });
      }

      const resumeSessionId =
        row.sessionSourceId === input.sourceGatewayId && row.sessionId !== null
          ? row.sessionId
          : null;

      return Result.ok<UpsertTurnValue, UpsertTurnError>({
        chat: row,
        resumeSessionId,
      });
    });
  },

  /**
   * Record the assistant-side completion of a turn: id-idempotently append
   * the assistant messages and atomically write `sessionId` + `sessionSourceId`
   * as a pair. Returns `{ notFound }` when the row does not exist or
   * `{ conflict, boundProvider }` when the stored provider differs.
   */
  appendAssistantTurn(
    userId: string,
    input: CompleteTurnInput
  ): Promise<AppendAssistantTurnResult> {
    return withDb.tx(async (tx) => {
      const existing = await tx.chatSession.findUnique({
        where: { userId_chatKey: { userId, chatKey: input.chatKey } },
      });

      if (!existing) {
        return Result.err<AppendAssistantTurnValue, AppendAssistantTurnError>({
          kind: "notFound",
        });
      }

      if (existing.provider !== input.provider) {
        return Result.err<AppendAssistantTurnValue, AppendAssistantTurnError>({
          kind: "providerConflict",
          boundProvider: existing.provider,
        });
      }

      const existingMessages = parseStoredMessages(existing.messages);
      const toAppend = filterNewMessages(input.messages, existingMessages);
      // Fully idempotent: if the gateway retries a completion write with
      // the same messages and the same session pair, short-circuit before
      // touching the DB. Mirrors the guard in `appendMessages`.
      const sessionUnchanged =
        input.sessionId === existing.sessionId &&
        input.sessionSourceId === existing.sessionSourceId;

      if (toAppend.length === 0 && sessionUnchanged) {
        return Result.ok<AppendAssistantTurnValue, AppendAssistantTurnError>({
          chat: existing,
        });
      }

      const mergedMessages = [...existingMessages, ...toAppend];

      const updated = await tx.chatSession.update({
        where: { userId_chatKey: { userId, chatKey: input.chatKey } },
        data: {
          messages: toPrismaJsonMessages(mergedMessages),
          sessionId: input.sessionId,
          sessionSourceId: input.sessionSourceId,
        },
      });

      return Result.ok<AppendAssistantTurnValue, AppendAssistantTurnError>({
        chat: updated,
      });
    });
  },
};

/**
 * Return only the messages whose id is not already present in `existing`.
 * Preserves incoming order; duplicate ids inside `incoming` are collapsed
 * to their first occurrence so a single batch cannot introduce duplicates.
 */
function filterNewMessages(
  incoming: ChatMessage[],
  existing: ChatMessage[]
): ChatMessage[] {
  const seenIds = new Set<string>();
  for (const m of existing) {
    seenIds.add(m.id);
  }
  const result: ChatMessage[] = [];
  for (const m of incoming) {
    if (seenIds.has(m.id)) {
      continue;
    }
    seenIds.add(m.id);
    result.push(m);
  }
  return result;
}
