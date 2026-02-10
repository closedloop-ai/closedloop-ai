# Chat Data Schema for AI-Powered PRD Generation

## Context

We're building a feature where PMs chat with an AI agent to generate and refine PRDs. The foundation is a chat interface powered by the Vercel AI SDK (`useChat` hook, `streamText`, `UIMessage`/`ModelMessage` types). This plan designs the data schema — Prisma models and shared TypeScript types — to persist conversations and reconstruct them for both UI rendering and AI context.

**Key user decision:** Conversations are **artifact-scoped** — a chat is attached to a specific PRD artifact. The PM navigates to a PRD and chats to generate/refine it.

## Vercel AI SDK Key Concepts

- **`UIMessage`** — frontend state with `id`, `role` (`system`|`user`|`assistant`), `parts[]` (text, file, tool-call, tool-result, source, custom data), and optional `metadata`
- **`ModelMessage`** — lightweight format sent to the AI model, converted from `UIMessage[]` via `convertToModelMessages()`
- **`useChat`** — React hook returning `messages: UIMessage[]` and `sendMessage()`
- **Persistence pattern** — server uses `result.toUIMessageStreamResponse({ originalMessages, onFinish: ({ messages }) => saveChat() })` to persist after streaming completes
- **Parts-based architecture** — messages no longer have a top-level `content` string; all content is in the `parts` array (text parts, file parts, tool-call parts, etc.)

## Schema Design

### Design Decisions

1. **Replace existing unused `Conversation`/`Message` models in-place** — same table names, new schema. No data exists to migrate.

2. **Store parts as vendor-neutral JSON** — rather than persisting the Vercel SDK's `UIMessagePart[]` verbatim, we define a Symphony-native `MessagePart` type that captures the semantics we need without Vercel-specific concerns (streaming states, `providerMetadata`, `tool-${NAME}` type encoding). Thin adapters (`toUIMessages` / `fromUIMessages`) convert between our format and the SDK's format. This avoids vendor lock-in — when we eventually replace the Vercel SDK, we rewrite the adapters, not the data.

3. **Artifact-scoped conversations** — `Conversation` has a required `artifactId` linking it to the PRD being generated/refined. Multiple conversations can exist per artifact (e.g., initial generation, then a revision session).

4. **Replace-all persistence strategy** — on each `onFinish`, delete all messages for the conversation and insert the full array. The SDK mutates messages in place (e.g., tool-call parts transition states), making append-only diffing impractical.

5. **`MessageRole` enum** — the SDK constrains roles to `system`, `user`, `assistant`. An enum ensures data integrity over a free-form string.

6. **Adapter layer for SDK interop** — the Vercel AI SDK's `UIMessage` type carries vendor-specific concerns that don't belong in persisted data:
   - Tool parts use `tool-${NAME}` type encoding instead of a generic discriminant
   - Parts carry transient streaming states (`streaming`, `input-streaming`, etc.)
   - `providerMetadata` leaks LLM provider internals into stored data
   - `DataUIPart` uses `data-${NAME}` prefixed types

   We isolate this with two adapter functions:
   - `fromUIMessages(uiMessages: UIMessage[]): DbMessage[]` — called in `onFinish` to strip SDK-specific fields before persisting
   - `toUIMessages(dbMessages: DbMessage[]): UIMessage[]` — called when loading from DB to reconstruct valid `UIMessage[]` for `useChat`

   During streaming, `useChat` manages its own in-memory `UIMessage[]` with all Vercel states — this is transient and never persisted. The adapters only run at persistence boundaries.

### Prisma Schema Changes

File: [schema.prisma](packages/database/prisma/schema.prisma)

#### New Enums

```prisma
enum MessageRole {
  system
  user
  assistant
}

enum ConversationStatus {
  ACTIVE
  COMPLETED
  ARCHIVED
}
```

#### Replaced `Conversation` Model

```prisma
model Conversation {
  id             String             @id @default(uuid(7)) @db.Uuid
  organizationId String             @map("organization_id") @db.Uuid
  userId         String             @map("user_id") @db.Uuid
  artifactId     String             @map("artifact_id") @db.Uuid
  agentType      String             @map("agent_type")        // "prd", "design", etc.
  title          String?                                       // auto-generated or user-set
  status         ConversationStatus @default(ACTIVE)
  tokenUsage     Json?              @map("token_usage")        // aggregate { promptTokens, completionTokens, totalTokens }
  createdAt      DateTime           @default(now()) @map("created_at")
  updatedAt      DateTime           @updatedAt @map("updated_at")

  // Relations
  organization Organization @relation(fields: [organizationId], references: [id])
  user         User         @relation(fields: [userId], references: [id])
  artifact     Artifact     @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  messages     Message[]

  @@index([organizationId, userId, status])
  @@index([organizationId, agentType])
  @@index([artifactId])
  @@index([userId])
  @@map("conversations")
}
```

#### Replaced `Message` Model

```prisma
model Message {
  id             String      @id @default(uuid(7)) @db.Uuid
  conversationId String      @map("conversation_id") @db.Uuid
  role           MessageRole
  parts          Json                                           // MessagePart[] — Symphony-native format (see TypeScript types)
  metadata       Json?                                         // model used, finish reason, custom metadata
  tokenUsage     Json?       @map("token_usage")               // { promptTokens, completionTokens, totalTokens }
  createdAt      DateTime    @default(now()) @map("created_at")

  // Relations
  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, createdAt])
  @@map("messages")
}
```

#### Relation Additions to Existing Models

Add to `Organization`:
```prisma
conversations Conversation[]
```

Add to `User`:
```prisma
conversations Conversation[]
```

Add to `Artifact`:
```prisma
conversations Conversation[]
```

### TypeScript Types

#### Shared API types — `packages/api/src/types/conversation.ts` (new file)

```typescript
// ---------------------------------------------------------------------------
// Enums & Constants
// ---------------------------------------------------------------------------

export const ConversationStatus = {
  Active: "ACTIVE",
  Completed: "COMPLETED",
  Archived: "ARCHIVED",
} as const;
export type ConversationStatus =
  (typeof ConversationStatus)[keyof typeof ConversationStatus];

export const MessageRole = {
  System: "system",
  User: "user",
  Assistant: "assistant",
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

export const AgentType = {
  Prd: "prd",
} as const;
export type AgentType = (typeof AgentType)[keyof typeof AgentType];

// ---------------------------------------------------------------------------
// MessagePart — vendor-neutral, Symphony-native format
// ---------------------------------------------------------------------------
// This is what gets persisted in the `parts` JSON column.
// No Vercel SDK streaming states, no providerMetadata, no tool-${NAME} encoding.

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      error?: string;
    }
  | { type: "source"; sourceId: string; url: string; title?: string }
  | { type: "reasoning"; text: string };

// ---------------------------------------------------------------------------
// Token Usage
// ---------------------------------------------------------------------------

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

// ---------------------------------------------------------------------------
// API Response Types
// ---------------------------------------------------------------------------

export type Message = {
  id: string;
  conversationId: string;
  role: MessageRole;
  parts: MessagePart[];
  metadata: Record<string, unknown> | null;
  tokenUsage: TokenUsage | null;
  createdAt: string;
};

export type Conversation = {
  id: string;
  organizationId: string;
  userId: string;
  artifactId: string;
  agentType: string;
  title: string | null;
  status: ConversationStatus;
  tokenUsage: TokenUsage | null;
  createdAt: string;
  updatedAt: string;
};

export type ConversationWithMessages = Conversation & {
  messages: Message[];
};

export type ConversationListItem = Pick<
  Conversation,
  "id" | "title" | "agentType" | "status" | "createdAt" | "updatedAt"
>;
```

#### Adapter layer — `apps/api/lib/message-adapters.ts` (new file)

Thin conversion functions at the persistence boundary. The Vercel SDK is only a dependency of this file.

```typescript
import type { UIMessage } from "ai";
import type { Message, MessagePart } from "@repo/api/src/types/conversation";

/**
 * Convert Vercel UIMessage[] → Symphony-native messages for DB persistence.
 * Called in the onFinish callback after streaming completes.
 *
 * Strips: streaming states, providerMetadata, tool-${NAME} type encoding.
 * Flattens: tool call + result into a single MessagePart with input/output.
 */
export function fromUIMessages(uiMessages: UIMessage[]): Omit<Message, "conversationId" | "tokenUsage" | "createdAt">[] { ... }

/**
 * Convert Symphony-native DB messages → Vercel UIMessage[] for useChat.
 * Called when loading a conversation from the database.
 *
 * Populates: state fields (text → "done", tool-call → "output-available"/"output-error"),
 *            tool-${NAME} type encoding from toolName.
 */
export function toUIMessages(dbMessages: Message[]): UIMessage[] { ... }
```

**Key adapter behaviors:**

| Vercel SDK format | Symphony-native format | Notes |
|---|---|---|
| `{ type: "text", text: "...", state: "streaming" }` | `{ type: "text", text: "..." }` | `state` dropped — persisted text is always done |
| `{ type: "tool-search", toolCallId: "...", state: "output-available", input: {...}, output: {...} }` | `{ type: "tool-call", toolCallId: "...", toolName: "search", input: {...}, output: {...} }` | Generic discriminant, toolName as data |
| `{ type: "tool-search", state: "output-error", errorText: "..." }` | `{ type: "tool-call", ..., error: "..." }` | `errorText` → `error` |
| `{ type: "reasoning", text: "...", providerMetadata: {...} }` | `{ type: "reasoning", text: "..." }` | `providerMetadata` dropped |
| `{ type: "source-url", sourceId: "...", url: "...", title: "..." }` | `{ type: "source", sourceId: "...", url: "...", title: "..." }` | Simplified type name |
| `{ type: "file", mediaType: "...", url: "...", filename: "..." }` | `{ type: "file", mediaType: "...", url: "...", filename: "..." }` | 1:1 mapping |

### Index Strategy

| Index | Query Pattern |
|-------|---------------|
| `[organizationId, userId, status]` | "My active conversations" (sidebar) |
| `[organizationId, agentType]` | "All PRD conversations in org" |
| `[artifactId]` | "Show chat history for this PRD" |
| `[userId]` | Prisma relation support |
| `[conversationId, createdAt]` | Load messages in chronological order |

### Data Flow Summary

```
Load existing conversation:
  GET /conversations/:id?include=messages
  → DB rows (Symphony-native MessagePart[])
  → toUIMessages() adapter converts to UIMessage[]
  → useChat initialized with restored UIMessage[]

Send new message (streaming):
  useChat.sendMessage() → POST /ai/prd with { conversationId, messages: UIMessage[] }
  → Server: convertToModelMessages(messages) → streamText()
  → Stream response back via toUIMessageStreamResponse()
  → onFinish callback:
      1. fromUIMessages(messages) → Symphony-native format
      2. Save to DB (replace strategy)

Reconstruct for AI context:
  DB rows → toUIMessages() → UIMessage[] → convertToModelMessages() → ModelMessage[]
  (adapter handles Symphony→Vercel, SDK handles Vercel→model format)

Future migration (drop Vercel SDK):
  DB rows → your own rendering/context logic
  (delete adapters, zero data migration needed)
```

## Files to Modify

| File | Change |
|------|--------|
| [schema.prisma](packages/database/prisma/schema.prisma) | Add enums, replace Conversation/Message models, add relations |
| `packages/api/src/types/conversation.ts` | New file — shared TypeScript types with vendor-neutral `MessagePart` |
| `apps/api/lib/message-adapters.ts` | New file — `toUIMessages()` / `fromUIMessages()` adapter functions |

## Verification

1. Run `cd packages/database && pnpm prisma migrate dev --name evolve_conversations_for_ai_chat` — should create migration cleanly
2. Run `pnpm typecheck` — no type errors from new types or changed relations
3. Run `pnpm lint` — no lint issues in new types file
4. Open Prisma Studio (`cd packages/database && pnpm prisma studio`) and verify the new `conversations` and `messages` tables exist with correct columns
