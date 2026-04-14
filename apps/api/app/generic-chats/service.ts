import { type GenericChat, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Shape of a single chat message stored in GenericChat.messages.
 * Backend-only — the same shape is used by the frontend but the
 * canonical definition for the DB contract lives here.
 */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  blocks?: unknown[];
};

export type CreateGenericChatInput = {
  userId: string;
  organizationId: string;
  chatKey: string;
  provider: string;
  model: string;
  context?: string;
  messages?: ChatMessage[];
};

export type AppendMessagesResult =
  | { chat: GenericChat }
  | { notFound: true }
  | { conflict: true; boundProvider: string };

export type TurnInput = {
  chatKey: string;
  userMessage: ChatMessage;
  provider: string;
  model: string;
  context?: string;
  sourceGatewayId: string;
};

export type UpsertTurnResult =
  | { conflict: true; boundProvider: string }
  | {
      conflict: false;
      chat: GenericChat;
      resumeSessionId: string | null;
    };

export type CompleteTurnInput = {
  chatKey: string;
  provider: string;
  messages: ChatMessage[];
  sessionId: string | null;
  sessionSourceId: string | null;
};

export type AppendAssistantTurnResult =
  | { notFound: true }
  | { conflict: true; boundProvider: string }
  | { notFound: false; conflict: false; chat: GenericChat };

/**
 * Service for `generic_chats` DB operations. All read/update operations are
 * scoped by (userId, chatKey) so cross-user access is impossible at the
 * query level. `organizationId` is accepted only by methods that create new
 * rows (`create`, `upsertTurn`) because those are the only operations that
 * need to stamp it on new records; read/append/delete paths derive isolation
 * purely from `userId`. `create` and `appendMessages` run inside `withDb.tx`
 * so the read-then-write merge is atomic against concurrent writers.
 */
export const genericChatsService = {
  /**
   * Find a chat by (userId, chatKey). Returns null when the row does not
   * exist or belongs to a different user. Plain `withDb` is sufficient —
   * no read-after-write coordination is required.
   */
  findByKey(userId: string, chatKey: string): Promise<GenericChat | null> {
    return withDb((db) =>
      db.genericChat.findUnique({
        where: { userId_chatKey: { userId, chatKey } },
      })
    );
  },

  /**
   * Create a new chat, or reconcile messages into an existing row when
   * (userId, chatKey) already exists. Reconciliation is id-based: only
   * messages whose id is not already stored are appended; existing order
   * is preserved and new ids go at the end. Returns the (possibly
   * reconciled) row. Runs inside a transaction so concurrent creates
   * cannot produce duplicate message ids.
   */
  create(data: CreateGenericChatInput): Promise<GenericChat> {
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
      const existing = await tx.genericChat.findUnique({
        where: { userId_chatKey: { userId, chatKey } },
      });

      if (!existing) {
        const created = await tx.genericChat.create({
          data: {
            userId,
            organizationId,
            chatKey,
            provider,
            model,
            context: context ?? null,
            messages: incoming as unknown as ChatMessage[] as never,
          },
        });
        log.info("Generic chat created", {
          chatId: created.id,
          userId,
          chatKey,
          provider,
        });
        return created;
      }

      const toAppend = filterNewMessages(
        incoming,
        existing.messages as unknown as ChatMessage[]
      );

      if (toAppend.length === 0) {
        return existing;
      }

      const mergedMessages = [
        ...(existing.messages as unknown as ChatMessage[]),
        ...toAppend,
      ];

      const updated = await tx.genericChat.update({
        where: { userId_chatKey: { userId, chatKey } },
        data: {
          messages: mergedMessages as unknown as ChatMessage[] as never,
        },
      });
      return updated;
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
      const existing = await tx.genericChat.findUnique({
        where: { userId_chatKey: { userId, chatKey } },
      });

      if (!existing) {
        return { notFound: true } as const;
      }

      if (existing.provider !== provider) {
        return {
          conflict: true,
          boundProvider: existing.provider,
        } as const;
      }

      const existingMessages = existing.messages as unknown as ChatMessage[];
      const toAppend = filterNewMessages(messagesToAppend, existingMessages);
      const sessionIdChanged =
        sessionId !== undefined && sessionId !== existing.sessionId;

      if (toAppend.length === 0 && !sessionIdChanged) {
        return { chat: existing };
      }

      const mergedMessages = [...existingMessages, ...toAppend];

      const updated = await tx.genericChat.update({
        where: { userId_chatKey: { userId, chatKey } },
        data: {
          messages: mergedMessages as unknown as ChatMessage[] as never,
          ...(sessionIdChanged ? { sessionId } : {}),
        },
      });
      return { chat: updated };
    });
  },

  /**
   * Hard delete a chat row. Idempotent: returns `true` when the row was
   * deleted, `false` when no row existed. `deleteMany` scoped to
   * (userId, chatKey) guarantees cross-user rows cannot be deleted.
   */
  async deleteChat(userId: string, chatKey: string): Promise<boolean> {
    const result = await withDb((db) =>
      db.genericChat.deleteMany({
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
      const existing = await tx.genericChat.findUnique({
        where: { userId_chatKey: { userId, chatKey: input.chatKey } },
      });

      let row: GenericChat;

      if (existing) {
        if (existing.provider !== input.provider) {
          return {
            conflict: true,
            boundProvider: existing.provider,
          } as const;
        }

        const existingMessages = existing.messages as unknown as ChatMessage[];
        const alreadyStored = existingMessages.some(
          (m) => m.id === input.userMessage.id
        );

        if (alreadyStored) {
          row = existing;
        } else {
          const mergedMessages = [...existingMessages, input.userMessage];
          row = await tx.genericChat.update({
            where: { userId_chatKey: { userId, chatKey: input.chatKey } },
            data: {
              messages: mergedMessages as unknown as ChatMessage[] as never,
            },
          });
        }
      } else {
        row = await tx.genericChat.create({
          data: {
            userId,
            organizationId,
            chatKey: input.chatKey,
            provider: input.provider,
            model: input.model,
            context: input.context ?? null,
            messages: [input.userMessage] as unknown as ChatMessage[] as never,
            sessionId: null,
            sessionSourceId: null,
          },
        });
        log.info("Generic chat created via upsertTurn", {
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

      return { conflict: false, chat: row, resumeSessionId } as const;
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
      const existing = await tx.genericChat.findUnique({
        where: { userId_chatKey: { userId, chatKey: input.chatKey } },
      });

      if (!existing) {
        return { notFound: true } as const;
      }

      if (existing.provider !== input.provider) {
        return {
          conflict: true,
          boundProvider: existing.provider,
        } as const;
      }

      const existingMessages = existing.messages as unknown as ChatMessage[];
      const toAppend = filterNewMessages(input.messages, existingMessages);
      // Fully idempotent: if the gateway retries a completion write with
      // the same messages and the same session pair, short-circuit before
      // touching the DB. Mirrors the guard in `appendMessages`.
      const sessionUnchanged =
        input.sessionId === existing.sessionId &&
        input.sessionSourceId === existing.sessionSourceId;

      if (toAppend.length === 0 && sessionUnchanged) {
        return { notFound: false, conflict: false, chat: existing } as const;
      }

      const mergedMessages = [...existingMessages, ...toAppend];

      const updated = await tx.genericChat.update({
        where: { userId_chatKey: { userId, chatKey: input.chatKey } },
        data: {
          messages: mergedMessages as unknown as ChatMessage[] as never,
          sessionId: input.sessionId,
          sessionSourceId: input.sessionSourceId,
        },
      });

      return { notFound: false, conflict: false, chat: updated } as const;
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
