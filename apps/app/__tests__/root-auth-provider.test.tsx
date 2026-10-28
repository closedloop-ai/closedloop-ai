/**
 * ISS-12054: the root layout mounts the server-resolved local-trusted identity
 * INSTEAD of Clerk's provider only when the `AUTH_MODE=local_trusted` guard
 * passed, and Clerk's provider everywhere else. Both halves are pinned: which
 * provider `RootAuthProvider` picks for a given identity, and that the layout
 * hands it an identity only when the guard says so.
 */
import type { LocalTrustedIdentity } from "@repo/auth/auth-mode";
import { LocalTrustedIdentityProvider } from "@repo/auth/local-trusted-client";
import { AuthProvider } from "@repo/auth/provider";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ active: false }));

vi.mock("@repo/auth/auth-mode", () => ({
  isLocalTrustedAuthActive: () => guard.active,
  resolveLocalTrustedIdentity: () => GUARDED_IDENTITY,
}));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/font/google", () => ({
  Silkscreen: () => ({ variable: "font-pixel" }),
}));
vi.mock("@repo/design-system/lib/fonts", () => ({ fonts: "test-font-class" }));
vi.mock("@/env", () => ({
  env: {
    CSP_ENABLED: false,
    NEXT_PUBLIC_API_URL: "https://api.closedloop.ai",
    NEXT_PUBLIC_APP_URL: "https://app.closedloop.ai",
    NEXT_PUBLIC_WEB_URL: "https://closedloop.ai",
    NEXT_PUBLIC_DOCS_URL: "https://closedloop.ai/docs",
  },
}));
vi.mock("@/lib/deployment-pin", () => ({
  resolveApiDeploymentPin: async () => undefined,
}));

import RootLayout from "../app/layout";
import { RootAuthProvider } from "../lib/root-auth-provider";

const GUARDED_IDENTITY: LocalTrustedIdentity = {
  orgId: "org_seed_sandbox",
  orgSlug: "seed-sandbox",
  userId: "user_seed_sandbox",
};

describe("RootAuthProvider", () => {
  it("mounts the local-trusted identity, and not Clerk, for a guarded identity", () => {
    const tree = RootAuthProvider({
      children: null,
      localTrustedAuthIdentity: GUARDED_IDENTITY,
      nonce: undefined,
    });

    expect(tree.type).toBe(LocalTrustedIdentityProvider);
    expect(tree.props.identity).toBe(GUARDED_IDENTITY);
  });

  it("mounts Clerk's provider when there is no identity", () => {
    const tree = RootAuthProvider({
      children: null,
      localTrustedAuthIdentity: null,
      nonce: "nonce-1",
    });

    expect(tree.type).toBe(AuthProvider);
    expect(tree.props.nonce).toBe("nonce-1");
  });
});

describe("app/layout.tsx feeds RootAuthProvider from the guard", () => {
  beforeEach(() => {
    guard.active = false;
  });

  it("passes the resolved identity only when the guard passes", async () => {
    guard.active = true;

    expect(rootAuthProviderProps(await renderLayout())).toMatchObject({
      localTrustedAuthIdentity: GUARDED_IDENTITY,
    });
  });

  it("passes no identity when the guard does not pass", async () => {
    expect(rootAuthProviderProps(await renderLayout())).toMatchObject({
      localTrustedAuthIdentity: null,
    });
  });
});

async function renderLayout(): Promise<ReactElement> {
  return (await RootLayout({ children: null })) as ReactElement;
}

function rootAuthProviderProps(node: ReactNode): Record<string, unknown> {
  const found = findElement(node);
  if (!found) {
    throw new Error("the root layout mounts no RootAuthProvider");
  }
  return found.props;
}

function findElement(
  node: ReactNode
): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    return node.map(findElement).find(Boolean);
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return undefined;
  }
  if (node.type === RootAuthProvider) {
    return node;
  }
  return findElement(node.props.children as ReactNode);
}
