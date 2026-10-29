/**
 * @file copilot-text.ts
 * @description Best-effort extraction of displayable text from a Copilot
 * payload, shared by the chat parser and the CLI event handlers. Extracted from
 * `copilot-parser.ts` (ISS-6885) when the CLI half moved to its own module —
 * both formats bury message text under the same set of aliases, so the fallback
 * order lives in one place rather than being duplicated per format.
 */
/** CR-1: Best-effort extraction of displayable text from a Copilot message payload. */
export function extractText(payload: unknown): string | null {
  if (payload == null) {
    return null;
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  // Direct text/content fields
  for (const key of [
    "text",
    "content",
    "markdown",
    "body",
    "value",
    "message",
  ]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) {
      return v;
    }
  }
  // Array of content parts (OpenAI-style)
  if (Array.isArray(obj.content)) {
    const parts = obj.content
      .map((p: unknown) => {
        if (typeof p === "string") {
          return p;
        }
        if (p && typeof p === "object") {
          const po = p as Record<string, unknown>;
          if (typeof po.text === "string") {
            return po.text;
          }
          if (typeof po.content === "string") {
            return po.content;
          }
        }
        return null;
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return null;
}
