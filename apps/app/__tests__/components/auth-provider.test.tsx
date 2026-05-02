/**
 * Unit tests for AuthProvider.
 * Verifies that logoImageUrl in Clerk appearance.options is populated from
 * the explicit logoUrl prop and falls back to the NEXT_PUBLIC_LOGO_URL env var.
 */
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ReceivedClerkProps = {
  appearance?: { options?: { logoImageUrl?: string } };
  children?: React.ReactNode;
};

const { mockClerkProvider } = vi.hoisted(() => ({
  mockClerkProvider: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: mockClerkProvider,
}));

vi.mock("@clerk/ui/themes", () => ({
  dark: undefined,
}));

const { mockKeys } = vi.hoisted(() => ({
  mockKeys: vi.fn(),
}));

vi.mock("@repo/auth/keys", () => ({
  keys: mockKeys,
}));

import { AuthProvider } from "@repo/auth/provider";

describe("AuthProvider — logoImageUrl in Clerk appearance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKeys.mockReturnValue({ NEXT_PUBLIC_LOGO_URL: undefined });
    mockClerkProvider.mockImplementation(
      ({ children }: { children: React.ReactNode }) => children
    );
  });

  it("passes logoUrl prop as logoImageUrl in Clerk appearance options", () => {
    const logoUrl = "https://example.com/logo.png";

    render(
      <AuthProvider logoUrl={logoUrl}>
        <div>child</div>
      </AuthProvider>
    );

    const receivedProps = mockClerkProvider.mock
      .calls[0]?.[0] as ReceivedClerkProps;
    expect(receivedProps?.appearance?.options?.logoImageUrl).toBe(logoUrl);
  });

  it("falls back to NEXT_PUBLIC_LOGO_URL env var when no logoUrl prop is given", () => {
    const envLogoUrl = "https://example.com/env-logo.png";
    mockKeys.mockReturnValue({ NEXT_PUBLIC_LOGO_URL: envLogoUrl });

    render(
      <AuthProvider>
        <div>child</div>
      </AuthProvider>
    );

    const receivedProps = mockClerkProvider.mock
      .calls[0]?.[0] as ReceivedClerkProps;
    expect(receivedProps?.appearance?.options?.logoImageUrl).toBe(envLogoUrl);
  });

  it("sets logoImageUrl to undefined when neither logoUrl prop nor env var is provided", () => {
    mockKeys.mockReturnValue({ NEXT_PUBLIC_LOGO_URL: undefined });

    render(
      <AuthProvider>
        <div>child</div>
      </AuthProvider>
    );

    const receivedProps = mockClerkProvider.mock
      .calls[0]?.[0] as ReceivedClerkProps;
    expect(receivedProps?.appearance?.options?.logoImageUrl).toBeUndefined();
  });

  it("prefers the explicit logoUrl prop over the env var", () => {
    const propLogoUrl = "https://example.com/prop-logo.png";
    const envLogoUrl = "https://example.com/env-logo.png";
    mockKeys.mockReturnValue({ NEXT_PUBLIC_LOGO_URL: envLogoUrl });

    render(
      <AuthProvider logoUrl={propLogoUrl}>
        <div>child</div>
      </AuthProvider>
    );

    const receivedProps = mockClerkProvider.mock
      .calls[0]?.[0] as ReceivedClerkProps;
    expect(receivedProps?.appearance?.options?.logoImageUrl).toBe(propLogoUrl);
  });
});
