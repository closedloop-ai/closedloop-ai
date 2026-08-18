import type { Prisma } from "@repo/database";

/**
 * Pure @-mention body helpers for native comments (FEA-3490).
 *
 * These functions carry no DB access — they only shape/read a ProseMirror-style
 * body doc. They live here, apart from the full `service.ts` module, so their
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
