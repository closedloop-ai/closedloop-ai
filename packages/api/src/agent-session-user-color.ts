import type { BasicUser } from "./types/user.ts";

/**
 * Fallback owner-dot color token for a session whose owner cannot be resolved to
 * an org user (rendered by consumers that always need a concrete color).
 */
export const DEFAULT_HUMAN_ACTOR_COLOR_TOKEN = "var(--muted-foreground)";

/**
 * Deterministic owner-dot color for the Sessions "Owner" column, derived from a
 * stable per-user source (id, then email) so the same person always gets the
 * same hue across renders and surfaces. Returns `null` for an unresolved owner
 * (consumers substitute {@link DEFAULT_HUMAN_ACTOR_COLOR_TOKEN} when they need a
 * concrete color).
 *
 * SSOT for both the cloud projection (`apps/api/app/agent-sessions`) and the
 * desktop local projection (`apps/desktop/.../shared-agent-sessions-api.ts`), so
 * the Local-mode Owner color matches Cloud instead of the desktop hardcoding
 * `null` (FEA-3456).
 */
export function buildUserColor(user: BasicUser | null): string | null {
  if (!user) {
    return null;
  }
  const source = user.id || user.email;
  let hash = 0;
  for (const char of source) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return `hsl(${hash} 65% 45%)`;
}
