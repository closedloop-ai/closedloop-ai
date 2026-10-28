import { AgentSessionStateActionRemoval } from "@repo/api/src/types/agent-session-state-action-removal";
import { expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext = createTestAuthContext();

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));

import { PATCH } from "./route";

it("returns a non-mutating 410 tombstone for stale state-action clients", async () => {
  mockAuthContext = createTestAuthContext();

  const response = await PATCH(
    createMockRequest({
      method: "PATCH",
      url: "http://localhost:3002/agent-sessions/session-1/state",
      body: { state: "IN_REVIEW" },
    }),
    createMockRouteContext({ id: "session-1" })
  );

  expect(response.status).toBe(410);
  await expect(response.json()).resolves.toEqual({
    success: false,
    error: AgentSessionStateActionRemoval.Message,
    code: AgentSessionStateActionRemoval.Code,
  });
});
