import { describe, expect, it } from "vitest";
import { DesktopSessionFromApiKeyRemoval, POST } from "./route";

describe("POST /desktop/session/from-api-key (removed)", () => {
  it("answers 410 with a non-retryable desktop-contract body", async () => {
    const response = POST();

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      code: DesktopSessionFromApiKeyRemoval.Code,
      retryable: false,
    });
  });

  it("never mints a session for a valid-looking key + PoP", async () => {
    // The exact request an already-installed Desktop build still sends. It must
    // get the tombstone, not tokens — a body carrying accessToken/refreshToken
    // would re-authenticate a user who signed out.
    const response = POST();

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("accessToken");
    expect(body).not.toHaveProperty("refreshToken");
    expect(response.status).toBe(410);
  });

  it("marks the removal non-retryable so old clients do not poll it", () => {
    expect(DesktopSessionFromApiKeyRemoval.Retryable).toBe(false);
  });
});
