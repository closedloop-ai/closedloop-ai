import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthMode,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  LOCAL_TRUSTED_USER_ID,
} from "../auth-mode";

// FEA-4334: prove the @repo/auth/server wrappers route BOTH ways — the default
// clerk mode delegates to the real Clerk `auth()`/`currentUser()` (unchanged),
// and the guarded local_trusted mode returns the synthetic identity WITHOUT
// calling Clerk. Clerk's server module is mocked so we can assert delegation and
// keep the test offline; `next/navigation` is mocked because the synthetic auth
// object's redirect helpers reference it.

const clerkAuthMock = vi.fn(() =>
  Promise.resolve({ orgId: "org_real_clerk", userId: "user_real_clerk" })
);
const clerkCurrentUserMock = vi.fn(() =>
  Promise.resolve({ id: "user_real_clerk" })
);

vi.mock("@clerk/nextjs/server", () => ({
  auth: clerkAuthMock,
  currentUser: clerkCurrentUserMock,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => url,
}));

const MUTATED_KEYS = [
  "AUTH_MODE",
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  "NODE_ENV",
  "VERCEL_ENV",
] as const;

const REFUSED_PATTERN = /refused/;

const original = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

describe("@repo/auth/server auth-mode wrappers", () => {
  beforeEach(() => {
    for (const key of MUTATED_KEYS) {
      original.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
    clerkAuthMock.mockClear();
    clerkCurrentUserMock.mockClear();
  });

  afterEach(() => {
    for (const [key, value] of original) {
      setEnv(key, value);
    }
    original.clear();
  });

  it("delegates to the real Clerk auth()/currentUser() in the default clerk mode", async () => {
    // No AUTH_MODE set → default clerk.
    const { auth, currentUser } = await import("../server");

    const authResult = await auth();
    const user = await currentUser();

    expect(clerkAuthMock).toHaveBeenCalledTimes(1);
    expect(clerkCurrentUserMock).toHaveBeenCalledTimes(1);
    expect(authResult.userId).toBe("user_real_clerk");
    expect(user?.id).toBe("user_real_clerk");
  });

  it("returns the synthetic identity WITHOUT calling Clerk in guarded local_trusted mode", async () => {
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "test");

    const { auth, currentUser } = await import("../server");

    const authResult = await auth();
    const user = await currentUser();

    expect(clerkAuthMock).not.toHaveBeenCalled();
    expect(clerkCurrentUserMock).not.toHaveBeenCalled();
    expect(authResult.userId).toBe(LOCAL_TRUSTED_USER_ID);
    expect(user?.id).toBe(LOCAL_TRUSTED_USER_ID);
  });

  it("THROWS from the wrapper (never grants) when local_trusted is set in production", async () => {
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "production");

    const { auth, currentUser } = await import("../server");

    // The guard throws synchronously (before any promise is returned), so a
    // misconfigured prod deploy fails loud instead of resolving a session.
    expect(() => auth()).toThrow(REFUSED_PATTERN);
    expect(() => currentUser()).toThrow(REFUSED_PATTERN);
    expect(clerkAuthMock).not.toHaveBeenCalled();
    expect(clerkCurrentUserMock).not.toHaveBeenCalled();
  });
});
