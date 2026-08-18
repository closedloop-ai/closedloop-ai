import { z } from "zod";
import { desktopAgentSessionsSyncResponseValidator } from "./agent-session";

/**
 * The full HTTP `ApiResult` envelope of `POST /desktop/agent-sessions/sync`,
 * as the DESKTOP parses it. Split out of `agent-session.ts` (at the
 * noExcessiveLinesPerFile ceiling) — only the two desktop response-parsing
 * call sites consume it. The success envelope is `.strict()` on purpose: it
 * is the reason the goal-stage-2 `acceptedSessionIds` field is request-gated
 * (see `desktopAgentSessionsSyncResponseValidator`), and loosening it would
 * silently drop that skew protection.
 */
export const desktopAgentSessionsSyncApiResultValidator = z.union([
  z
    .object({
      success: z.literal(true),
      data: desktopAgentSessionsSyncResponseValidator,
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      error: z.string(),
    })
    .passthrough(),
]);
export type DesktopAgentSessionsSyncApiResult = z.infer<
  typeof desktopAgentSessionsSyncApiResultValidator
>;
