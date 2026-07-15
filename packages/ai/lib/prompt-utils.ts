/**
 * Escape XML closing tags inside untrusted content so it can't break out of an
 * enclosing XML tag and inject directives into an LLM prompt. Shared by every
 * prompt that wraps document/plan data in XML delimiters (e.g. the documents
 * merge service and the Linear task extractor).
 */
export function escapeXmlClosingTags(content: string): string {
  return content.replaceAll("</", "&lt;/");
}
