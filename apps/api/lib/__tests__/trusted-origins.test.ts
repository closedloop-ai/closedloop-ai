import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTrustedOrigin } from "@/lib/trusted-origins";

describe("isTrustedOrigin", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_DOMAIN", "preview.closedloop-stage.ai");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.closedloop.ai");
    vi.stubEnv("NEXT_PUBLIC_WEB_URL", "https://www.closedloop.ai");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects null or empty origins", () => {
    expect(isTrustedOrigin(null)).toBe(false);
    expect(isTrustedOrigin("")).toBe(false);
  });

  it("allows configured production origins", () => {
    expect(isTrustedOrigin("https://app.closedloop.ai")).toBe(true);
    expect(isTrustedOrigin("https://www.closedloop.ai")).toBe(true);
  });

  it("allows preview suffix hosts and their subdomains", () => {
    expect(isTrustedOrigin("https://preview.closedloop-stage.ai")).toBe(true);
    expect(
      isTrustedOrigin("https://app-stage-9e4itcla9.preview.closedloop-stage.ai")
    ).toBe(true);
    expect(
      isTrustedOrigin(
        "https://app-stage-git-multi-repo-team-config-ui.preview.closedloop-stage.ai"
      )
    ).toBe(true);
  });

  it("rejects partial-match preview suffix hosts without a dot boundary", () => {
    expect(isTrustedOrigin("https://evilpreview.closedloop-stage.ai")).toBe(
      false
    );
  });

  it("rejects origins that include a path or query string", () => {
    expect(isTrustedOrigin("https://app.closedloop.ai/path")).toBe(false);
    expect(isTrustedOrigin("https://app.closedloop.ai?x=1")).toBe(false);
  });

  it("rejects malformed origins", () => {
    expect(isTrustedOrigin("not a url")).toBe(false);
  });

  it("rejects arbitrary *.vercel.app origins, including app- prefixed ones", () => {
    // Regression: the previous fallback `hostname.endsWith('.vercel.app')
    // && hostname.startsWith('app-')` accepted Vercel projects published
    // by any third-party team. Legitimate previews live under
    // *.preview.closedloop-stage.ai, so the vercel.app fallback is gone.
    expect(isTrustedOrigin("https://app-evil-otherteam.vercel.app")).toBe(
      false
    );
    expect(
      isTrustedOrigin("https://app-stage-git-foo-closed-loop.vercel.app")
    ).toBe(false);
    expect(isTrustedOrigin("https://anything.vercel.app")).toBe(false);
  });

  it("allows http://localhost:* in non-production environments only", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isTrustedOrigin("http://localhost:3000")).toBe(true);
    expect(isTrustedOrigin("http://localhost:54321")).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    expect(isTrustedOrigin("http://localhost:3000")).toBe(true); // still in default allowlist
    expect(isTrustedOrigin("http://localhost:54321")).toBe(false);
  });
});
