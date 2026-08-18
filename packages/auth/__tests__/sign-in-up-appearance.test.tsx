import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { githubFirstAuthPageAppearance } from "../components/appearance";

// Stub Clerk's real embeds — they require a ClerkProvider at runtime. We only
// need to capture the `appearance` prop each wrapper forwards.
vi.mock("@clerk/nextjs", () => ({
  SignIn: (props: { appearance?: unknown }) => props,
  SignUp: (props: { appearance?: unknown }) => props,
}));

/**
 * Renders one of the embed function components in isolation (no DOM) and
 * returns the `appearance` prop it forwarded to the mocked Clerk embed.
 */
function forwardedAppearance(component: () => ReactElement): unknown {
  const element = component();
  return (element.props as { appearance?: unknown }).appearance;
}

// FEA-4059: the GitHub-first appearance is the DEFAULT for both auth embeds —
// it is applied unconditionally.
describe("sign-in / sign-up appearance wiring", () => {
  describe("SignIn", () => {
    it("applies the GitHub-first appearance as the default", async () => {
      const { SignIn } = await import("../components/sign-in");
      expect(forwardedAppearance(SignIn)).toEqual(
        githubFirstAuthPageAppearance
      );
    });
  });

  describe("SignUp", () => {
    it("applies the GitHub-first appearance as the default", async () => {
      const { SignUp } = await import("../components/sign-up");
      expect(forwardedAppearance(SignUp)).toEqual(
        githubFirstAuthPageAppearance
      );
    });
  });
});
