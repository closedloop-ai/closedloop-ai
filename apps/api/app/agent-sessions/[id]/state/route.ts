import {
  AgentSessionStateActionRemoval,
  type AgentSessionStateUpdateResponse,
} from "@repo/api/src/types/agent-session";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { goneResponse } from "@/lib/route-utils";

/**
 * Compatibility tombstone for the removed Session Trace feedback/action bar.
 *
 * Stale deployed browser bundles can still call this endpoint until they age
 * out. Keep the route shape available, but do not parse, persist, or mutate
 * session state.
 */
export const PATCH = withAnyAuth<
  AgentSessionStateUpdateResponse,
  "/agent-sessions/[id]/state"
>(async () =>
  goneResponse(AgentSessionStateActionRemoval.Message, {
    code: AgentSessionStateActionRemoval.Code,
  })
);
