/**
 * ISS-4905: `hasApiKeyScopes` is the scope gate every `withApiKeyAuth` route
 * with `requiredScopes` runs through. It used to substitute the FULL scope set
 * (`context.apiKeyScopes ?? [...API_KEY_SCOPES]`, `admin` included) whenever the
 * scope list was absent — a fail-open authorization default. These tests pin the
 * fail-closed behavior and the monitored log that surfaces the corrupt row.
 */

import { API_KEY_SCOPES_UNRESOLVABLE_EVENT } from "@repo/api/src/utils/api-key-scope-resolution";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError },
}));

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { hasApiKeyScopes } from "../api-key-scopes";
import type { AuthContext } from "../with-auth";

function apiKeyContext(scopes: ApiKeyScope[] | undefined): AuthContext {
  return {
    authMethod: "api_key",
    apiKeyScopes: scopes,
  } as unknown as AuthContext;
}

beforeEach(() => {
  logError.mockReset();
});

describe("hasApiKeyScopes", () => {
  it("grants session auth without consulting scopes", () => {
    const context = {
      authMethod: "session",
      apiKeyScopes: undefined,
    } as unknown as AuthContext;

    expect(hasApiKeyScopes(context, ["admin"])).toBe(true);
    expect(hasApiKeyScopes(context, ["read", "write", "delete"])).toBe(true);
    expect(logError).not.toHaveBeenCalled();
  });

  it("grants an api key that carries the required scopes", () => {
    expect(hasApiKeyScopes(apiKeyContext(["read", "write"]), ["write"])).toBe(
      true
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it("denies an api key that is missing a required scope", () => {
    expect(hasApiKeyScopes(apiKeyContext(["read"]), ["write"])).toBe(false);
    expect(hasApiKeyScopes(apiKeyContext(["read"]), ["delete"])).toBe(false);
  });

  it.each<[string, ApiKeyScope[] | undefined, string]>([
    ["an empty scope array", [], "empty"],
    ["an absent scope list", undefined, "absent"],
    [
      "scopes this server does not recognize",
      ["superuser"] as unknown as ApiKeyScope[],
      "all_unrecognized",
    ],
  ])("fails closed and reports the monitored event for %s", (_label, scopes, expectedReason) => {
    expect(hasApiKeyScopes(apiKeyContext(scopes), ["read"])).toBe(false);
    expect(hasApiKeyScopes(apiKeyContext(scopes), ["delete"])).toBe(false);

    expect(logError).toHaveBeenCalledWith(
      API_KEY_SCOPES_UNRESOLVABLE_EVENT,
      expect.objectContaining({
        surface: "with_api_key_auth",
        reason: expectedReason,
      })
    );
  });
});
