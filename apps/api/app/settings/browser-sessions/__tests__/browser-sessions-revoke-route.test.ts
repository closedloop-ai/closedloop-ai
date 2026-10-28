import { BrowserSessionErrorCode } from "@repo/api/src/types/browser-session";
import { LOCAL_TRUSTED_SESSION_ID } from "@repo/auth/auth-mode";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Clerk session ids are `sess_` plus 27 base62 characters, and the route's
 * guard enforces that length. Short labels like `sess_other` are not merely
 * unrealistic here — they are rejected as malformed, so every fixture id is
 * padded to the real shape. Hoisted because the mock auth context below is
 * itself hoisted and needs one.
 */
const { sessionId } = vi.hoisted(() => ({
  sessionId: (label: string) => `sess_${label}${"x".repeat(27 - label.length)}`,
}));

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    clerkSessionId: sessionId("current") as string | undefined,
    authMethod: "session" as "session" | "api_key" | "desktop_session",
    user: { id: "user-1", organizationId: "org-1" },
  },
  getBrowserSessionOwner: vi.fn(),
  revokeBrowserSession: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getBrowserSessionOwner: mocks.getBrowserSessionOwner,
    revokeBrowserSession: mocks.revokeBrowserSession,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

import { DELETE } from "../[sessionId]/route";

function revoke(sessionId: string) {
  return DELETE(
    new NextRequest(`http://localhost/settings/browser-sessions/${sessionId}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ sessionId }) }
  );
}

beforeEach(() => {
  mocks.getBrowserSessionOwner.mockReset();
  mocks.revokeBrowserSession.mockReset();
  mocks.revokeBrowserSession.mockResolvedValue(undefined);
  mocks.authContext.clerkSessionId = sessionId("current");
  mocks.authContext.authMethod = "session";
});

describe("DELETE /settings/browser-sessions/[sessionId]", () => {
  it("revokes another session the caller owns", async () => {
    mocks.getBrowserSessionOwner.mockResolvedValue({
      userId: "clerk-user-1",
    });

    const response = await revoke(sessionId("other"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ revoked: true });
    expect(mocks.revokeBrowserSession).toHaveBeenCalledWith(sessionId("other"));
  });

  it("refuses the caller's own current session and does not revoke it", async () => {
    const response = await revoke(sessionId("current"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.metadata?.code ?? body.code).toBe(
      BrowserSessionErrorCode.CurrentSessionNotRevocable
    );
    // The status alone would pass even if the session had been revoked first.
    expect(mocks.revokeBrowserSession).not.toHaveBeenCalled();
    // Refused before the provider is consulted at all.
    expect(mocks.getBrowserSessionOwner).not.toHaveBeenCalled();
  });

  it("gives the local_trusted synthetic session the current-session 409, not a malformed-id 404 (ISS-11468)", async () => {
    // The boundary lists this id as the caller's session under local_trusted,
    // so it has to clear the shape guard to reach the current-session check.
    mocks.authContext.clerkSessionId = LOCAL_TRUSTED_SESSION_ID;

    const response = await revoke(LOCAL_TRUSTED_SESSION_ID);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.metadata?.code ?? body.code).toBe(
      BrowserSessionErrorCode.CurrentSessionNotRevocable
    );
    expect(mocks.revokeBrowserSession).not.toHaveBeenCalled();
  });

  it("will not revoke another user's session, and does not confirm it exists", async () => {
    mocks.getBrowserSessionOwner.mockResolvedValue({
      userId: "clerk-user-2",
    });

    const response = await revoke(sessionId("someoneelse"));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.metadata?.code ?? body.code).toBe(
      BrowserSessionErrorCode.SessionNotFound
    );
    expect(mocks.revokeBrowserSession).not.toHaveBeenCalled();
  });

  it("answers a guessed id exactly as it answers a real one it may not touch", async () => {
    mocks.getBrowserSessionOwner.mockResolvedValue(null);
    const unknown = await revoke(sessionId("guessed"));
    const unknownBody = await unknown.json();

    mocks.getBrowserSessionOwner.mockResolvedValue({
      userId: "clerk-user-2",
    });
    const foreign = await revoke(sessionId("someoneelse"));
    const foreignBody = await foreign.json();

    // Byte-identical on purpose: a distinguishable answer would let a caller
    // enumerate which session ids are real.
    expect(unknown.status).toBe(foreign.status);
    expect(unknownBody).toEqual(foreignBody);
  });

  it("treats an already-revoked session as satisfied", async () => {
    mocks.getBrowserSessionOwner.mockResolvedValue({
      userId: "clerk-user-1",
    });
    mocks.revokeBrowserSession.mockResolvedValue(undefined);

    const response = await revoke(sessionId("alreadygone"));

    expect(response.status).toBe(200);
  });

  // Label first, id second: the 100k case would otherwise print its whole id as
  // the test name, burying every other line in the CI log.
  it.each([
    ["a traversal attempt", "..%2Fusers%2Fuser_x"],
    ["a wrong-prefix id", "not-a-session-id"],
    ["an id with a space", "sess_has spaces"],
    ["one character under the length floor", `sess_${"a".repeat(19)}`],
    ["one character over the length ceiling", `sess_${"a".repeat(65)}`],
    [
      "the 100k id that fails the provider's transport",
      `sess_${"a".repeat(100_000)}`,
    ],
  ])(
    "refuses %s before it can reach the provider",
    async (_label, malformed) => {
      const response = await revoke(malformed);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.metadata?.code ?? body.code).toBe(
        BrowserSessionErrorCode.SessionNotFound
      );
      // The point of the guard: the id never becomes a path segment in a
      // secret-key-authenticated provider request.
      expect(mocks.getBrowserSessionOwner).not.toHaveBeenCalled();
      expect(mocks.revokeBrowserSession).not.toHaveBeenCalled();
    }
  );

  it("lets a Desktop caller revoke a browser session, since none is its own", async () => {
    mocks.authContext.authMethod = "desktop_session";
    mocks.authContext.clerkSessionId = undefined;
    mocks.getBrowserSessionOwner.mockResolvedValue({
      userId: "clerk-user-1",
    });

    const response = await revoke(sessionId("other"));

    expect(response.status).toBe(200);
    expect(mocks.revokeBrowserSession).toHaveBeenCalledWith(sessionId("other"));
  });

  it("refuses a machine api-key credential", async () => {
    mocks.authContext.authMethod = "api_key";

    const response = await revoke(sessionId("other"));

    expect(response.status).toBe(403);
    expect(mocks.revokeBrowserSession).not.toHaveBeenCalled();
  });

  it("answers 503 when the ownership read fails, and revokes nothing", async () => {
    mocks.getBrowserSessionOwner.mockRejectedValue(new Error("clerk down"));

    const response = await revoke(sessionId("other"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.metadata?.code ?? body.code).toBe(
      BrowserSessionErrorCode.ProviderUnavailable
    );
    expect(mocks.revokeBrowserSession).not.toHaveBeenCalled();
  });
});
