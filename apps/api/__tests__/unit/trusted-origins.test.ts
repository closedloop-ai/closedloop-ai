import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTrustedOrigin } from "@/lib/trusted-origins";

describe("isTrustedOrigin", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.closedloop.ai");
    vi.stubEnv("NEXT_PUBLIC_WEB_URL", "https://closedloop.ai");
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("explicit allowlist", () => {
    it("trusts localhost:3000", () => {
      expect(isTrustedOrigin("http://localhost:3000")).toBe(true);
    });

    it("trusts NEXT_PUBLIC_APP_URL", () => {
      expect(isTrustedOrigin("https://app.closedloop.ai")).toBe(true);
    });

    it("trusts NEXT_PUBLIC_WEB_URL", () => {
      expect(isTrustedOrigin("https://closedloop.ai")).toBe(true);
    });
  });

  describe("localhost in non-production", () => {
    it("trusts any localhost port in non-production", () => {
      vi.stubEnv("NODE_ENV", "development");
      expect(isTrustedOrigin("http://localhost:5173")).toBe(true);
    });

    it("rejects non-3000 localhost in production", () => {
      expect(isTrustedOrigin("http://localhost:5173")).toBe(false);
    });
  });

  describe("preview suffix", () => {
    it("trusts subdomains of the preview suffix", () => {
      expect(
        isTrustedOrigin("https://app-stage.preview.closedloop-stage.ai")
      ).toBe(true);
    });

    it("trusts the bare preview suffix", () => {
      expect(isTrustedOrigin("https://preview.closedloop-stage.ai")).toBe(true);
    });

    it("rejects non-matching preview domains", () => {
      expect(isTrustedOrigin("https://evil.preview.attacker.ai")).toBe(false);
    });
  });

  describe("Vercel preview deployments", () => {
    it("trusts our team preview deployments", () => {
      expect(
        isTrustedOrigin(
          "https://app-stage-git-my-branch-closed-loop.vercel.app"
        )
      ).toBe(true);
    });

    it("rejects hash-based preview deployments (no -git- segment)", () => {
      expect(
        isTrustedOrigin("https://app-stage-abc123-closed-loop.vercel.app")
      ).toBe(false);
    });

    it("rejects attacker Vercel deployments (FEA-954)", () => {
      expect(isTrustedOrigin("https://app-evil.vercel.app")).toBe(false);
    });

    it("rejects attacker deployments with app- prefix on different team", () => {
      expect(isTrustedOrigin("https://app-evil-attacker-team.vercel.app")).toBe(
        false
      );
    });

    it("rejects Vercel deployments without app- prefix", () => {
      expect(isTrustedOrigin("https://web-stage-closed-loop.vercel.app")).toBe(
        false
      );
    });

    it("rejects attacker embedding team slug in project name", () => {
      expect(
        isTrustedOrigin("https://app-closed-loop-evil-team.vercel.app")
      ).toBe(false);
    });

    it("rejects attacker Vercel team slug ending in closed-loop", () => {
      expect(
        isTrustedOrigin("https://app-stage-fake-closed-loop.vercel.app")
      ).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("rejects null origin", () => {
      expect(isTrustedOrigin(null)).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isTrustedOrigin("")).toBe(false);
    });

    it("rejects malformed URL", () => {
      expect(isTrustedOrigin("not-a-url")).toBe(false);
    });

    it("rejects origin with trailing path", () => {
      expect(isTrustedOrigin("https://app.closedloop.ai/some/path")).toBe(
        false
      );
    });
  });
});
