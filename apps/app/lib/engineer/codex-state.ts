import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Build the path for a context-specific Codex chat state file.
 *  No chatContextId → legacy codex-chat.json (backwards compat). */
export function getCodexChatStatePath(
  claudeWorkDir: string,
  chatContextId?: string
): string {
  if (!chatContextId) {
    return join(claudeWorkDir, "codex-chat.json");
  }
  const sanitized = chatContextId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  return join(claudeWorkDir, `codex-chat-${sanitized}.json`);
}

/** Delete shared-surface Codex chat state files only:
 *  legacy + general + review.
 *  Do NOT delete comment-specific files; those are scoped to comment-chat. */
export function deleteSharedCodexChatState(claudeWorkDir: string): void {
  for (const path of [
    getCodexChatStatePath(claudeWorkDir),
    getCodexChatStatePath(claudeWorkDir, "general"),
    getCodexChatStatePath(claudeWorkDir, "review"),
  ]) {
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* best-effort */
      }
    }
  }
}
