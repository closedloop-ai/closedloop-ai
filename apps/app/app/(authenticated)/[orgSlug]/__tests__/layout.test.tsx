import { AuthMode, E2E_LOCAL_TRUSTED_AUTH_ENV } from "@repo/auth/auth-mode";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup — hoisted so vi.mock factories can reference them
// ---------------------------------------------------------------------------

const { mockAuth, mockOrgIdentityProvider } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockOrgIdentityProvider: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({ auth: mockAuth }));

// Capture the props the server layout hands the client provider. The provider
// itself is exercised by org-identity-provider.test.tsx; here the contract under
// test is only what the SERVER computes and passes down.
vi.mock("../org-identity-provider", () => ({
  default: (props: { readonly children: ReactNode }) => {
    mockOrgIdentityProvider(props);
    return <div>{props.children}</div>;
  },
}));

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks are registered
// ---------------------------------------------------------------------------

import OrgSlugLayout from "../layout";

// ISS-4406: the env keys the local_trusted guard reads. Snapshotted and
// restored EXACTLY (deleted when originally unset, never assigned "undefined"),
// and cleared before each case so inherited local/CI state cannot satisfy an
// earlier branch and mask a regression.
const MUTATED_ENV_KEYS = [
  "AUTH_MODE",
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  "NODE_ENV",
  "VERCEL_ENV",
] as const;

const ORG_SLUG = "closedloop-ai";
const REFUSED_PATTERN = /refused/;

const originalEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

function isolateEnv(): void {
  for (const key of MUTATED_ENV_KEYS) {
    if (!originalEnv.has(key)) {
      originalEnv.set(key, process.env[key]);
    }
    Reflect.deleteProperty(process.env, key);
  }
}

async function renderLayout(): Promise<void> {
  render(
    await OrgSlugLayout({
      children: <div>child content</div>,
      params: Promise.resolve({ orgSlug: ORG_SLUG }),
    })
  );
}

describe("OrgSlugLayout bypassClientOrgGate wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ orgSlug: ORG_SLUG, orgId: "org_123" });
  });

  afterEach(() => {
    for (const [key, value] of originalEnv) {
      setEnv(key, value);
    }
    originalEnv.clear();
  });

  it("passes bypassClientOrgGate=false under the default clerk env", async () => {
    isolateEnv();
    // NODE_ENV=test and the e2e opt-in are both set: only the missing AUTH_MODE
    // keeps the gate closed, so a regression that ignored AUTH_MODE would fail.
    setEnv("NODE_ENV", "test");
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");

    await renderLayout();

    expect(mockOrgIdentityProvider).toHaveBeenCalledWith(
      expect.objectContaining({ bypassClientOrgGate: false, orgSlug: ORG_SLUG })
    );
    expect(screen.getByText("child content")).toBeInTheDocument();
  });

  it("passes bypassClientOrgGate=false when AUTH_MODE is explicitly clerk", async () => {
    isolateEnv();
    setEnv("AUTH_MODE", AuthMode.Clerk);
    setEnv("NODE_ENV", "test");
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");

    await renderLayout();

    expect(mockOrgIdentityProvider).toHaveBeenCalledWith(
      expect.objectContaining({ bypassClientOrgGate: false })
    );
  });

  it("passes bypassClientOrgGate=true only when local_trusted is fully active", async () => {
    isolateEnv();
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv("NODE_ENV", "test");
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");

    await renderLayout();

    expect(mockOrgIdentityProvider).toHaveBeenCalledWith(
      expect.objectContaining({ bypassClientOrgGate: true, orgSlug: ORG_SLUG })
    );
  });

  it("keeps the gate closed when AUTH_MODE=local_trusted lacks the e2e opt-in", async () => {
    isolateEnv();
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv("NODE_ENV", "test");

    // The guard fails closed by throwing rather than silently downgrading, so a
    // misconfigured deploy can never render the bypass. Assert the throw — not a
    // `false` prop — because that is the production-safety contract.
    await expect(renderLayout()).rejects.toThrow(REFUSED_PATTERN);
    expect(mockOrgIdentityProvider).not.toHaveBeenCalled();
  });

  it("keeps the gate closed when AUTH_MODE=local_trusted reaches production", async () => {
    isolateEnv();
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv("NODE_ENV", "production");
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");

    await expect(renderLayout()).rejects.toThrow(REFUSED_PATTERN);
    expect(mockOrgIdentityProvider).not.toHaveBeenCalled();
  });

  it("404s before consulting the gate when there is no active org", async () => {
    isolateEnv();
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv("NODE_ENV", "test");
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    mockAuth.mockResolvedValue({ orgSlug: null, orgId: null });

    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
    expect(mockOrgIdentityProvider).not.toHaveBeenCalled();
  });
});
