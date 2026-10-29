import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import type { Prisma } from "@repo/database";
import { z } from "zod";

/**
 * Pure @-mention body helpers (FEA-3490): native comment bodies, plus the
 * stored `LIVEBLOCKS_V1` bodies read by PLN-2187 T-2.1.
 *
 * These functions carry no DB access — they only shape/read a stored body doc. They live here, apart from the full `service.ts` module, so their
 * package-local unit tests and the `trace-comments` service can import them
 * without pulling in `service.ts`'s `@repo/database`/`@repo/collaboration`
 * dependencies (root AGENTS.md: package-local pure-helper tests belong against a
 * lightweight module). `Prisma.InputJsonObject` is a type-only import.
 */

/**
 * Minimal ProseMirror-style doc for a plain-text native comment body. Native
 * comment rows set `plainText` directly rather than relying on
 * `extractPlainText`, which only understands the Liveblocks CommentBody
 * format.
 *
 * `mentions` (FEA-3490) is an optional, org-scoped list of @-mentioned user IDs
 * persisted alongside the text as a sibling doc key. It is additive: callers
 * that omit it store exactly the previous shape, and readers treat a missing key
 * as no mentions. Callers are responsible for filtering the list to the caller's
 * organization before passing it here.
 */
export function textBody(
  text: string,
  mentions?: readonly string[]
): Prisma.InputJsonObject {
  const paragraph = {
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  } satisfies Prisma.InputJsonObject;

  return {
    type: "doc",
    content: [paragraph],
    ...(mentions && mentions.length > 0 ? { mentions: [...mentions] } : {}),
  } satisfies Prisma.InputJsonObject;
}

/**
 * Reads the org-scoped @-mention user-ID list persisted on a native comment
 * body doc by {@link textBody} (FEA-3490). Returns an empty array when the body
 * is not the expected shape or carries no mentions.
 */
export function extractBodyMentions(body: unknown): string[] {
  if (!(body && typeof body === "object")) {
    return [];
  }
  const raw = (body as { mentions?: unknown }).mentions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
}

/** The user ids a stored comment body mentions, read per its `bodyFormat`. */
export function extractCommentMentions(
  body: unknown,
  bodyFormat: CommentBodyFormat
): string[] {
  return bodyFormat === CommentBodyFormat.LiveblocksV1
    ? extractLiveblocksBodyMentions(body)
    : extractBodyMentions(body);
}

/**
 * PLN-2187 T-2.1: the user ids a stored `LIVEBLOCKS_V1` body mentions, in
 * order and once each. A group mention names no user, and a body or element
 * of another shape is skipped rather than failing the read.
 */
export function extractLiveblocksBodyMentions(body: unknown): string[] {
  const parsed = liveblocksBodyBlocksSchema.safeParse(body);
  if (!parsed.success) {
    return [];
  }
  const mentions = new Set<string>();
  for (const block of parsed.data.content) {
    const paragraph = liveblocksBlockChildrenSchema.safeParse(block);
    for (const child of paragraph.success ? paragraph.data.children : []) {
      const mention = liveblocksMentionSchema.safeParse(child);
      if (mention.success && isUserMention(mention.data.kind)) {
        mentions.add(mention.data.id);
      }
    }
  }
  return [...mentions];
}

function isUserMention(kind: string | undefined): boolean {
  return kind === undefined || kind === LIVEBLOCKS_USER_MENTION;
}

const LIVEBLOCKS_USER_MENTION = "user";

const liveblocksBodyBlocksSchema = z.object({ content: z.array(z.unknown()) });

const liveblocksBlockChildrenSchema = z.object({
  children: z.array(z.unknown()),
});

const liveblocksMentionSchema = z.object({
  type: z.literal("mention"),
  id: z.string().min(1),
  kind: z.string().optional(),
});
