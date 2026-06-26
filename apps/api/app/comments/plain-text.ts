import type {
  CommentBody,
  CommentBodyInlineElement,
} from "@repo/collaboration/server/webhook";

/**
 * Extract plain text from a Liveblocks CommentBody structure.
 * Returns null for undefined bodies or bodies with no content.
 */
export function extractPlainText(body: CommentBody | undefined): string | null {
  if (!body) {
    return null;
  }

  const { content } = body;

  if (!content || content.length === 0) {
    return null;
  }

  const paragraphs: string[] = [];

  for (const paragraph of content) {
    if (!Array.isArray(paragraph.children)) {
      continue;
    }

    paragraphs.push(paragraph.children.map(inlineElementToText).join(""));
  }

  const result = paragraphs.join("\n");
  return result.length > 0 ? result : null;
}

function inlineElementToText(child: CommentBodyInlineElement): string {
  if ("text" in child && typeof child.text === "string") {
    return child.text;
  }
  if (child.type === "mention") {
    return `@${child.id}`;
  }
  if (child.type === "link") {
    return child.text ?? child.url;
  }
  return "";
}
