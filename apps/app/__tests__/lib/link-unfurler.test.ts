import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { rewriteForLinkUnfurler } from "@/lib/link-unfurler";

function makeRequest(pathname: string, userAgent: string | null): NextRequest {
  const url = `http://localhost:3000${pathname}`;
  if (userAgent !== null) {
    return new NextRequest(url, { headers: { "user-agent": userAgent } });
  }
  return new NextRequest(url);
}

describe("rewriteForLinkUnfurler", () => {
  describe("returns null for regular browser user agents", () => {
    it("returns null for Chrome", () => {
      const request = makeRequest(
        "/prds/my-slug",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );
      expect(rewriteForLinkUnfurler(request)).toBeNull();
    });

    it("returns null for Firefox", () => {
      const request = makeRequest(
        "/artifacts/some-id",
        "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/121.0"
      );
      expect(rewriteForLinkUnfurler(request)).toBeNull();
    });

    it("returns null for Safari", () => {
      const request = makeRequest(
        "/issues/my-issue",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
      );
      expect(rewriteForLinkUnfurler(request)).toBeNull();
    });
  });

  describe("returns null when user-agent header is absent", () => {
    it("returns null when no user-agent header is set", () => {
      const request = makeRequest("/prds/my-slug", null);
      expect(rewriteForLinkUnfurler(request)).toBeNull();
    });
  });

  describe("returns null for non-artifact paths with bot user agents", () => {
    it("returns null for /settings", () => {
      const request = makeRequest(
        "/settings",
        "Slackbot 1.0 (+https://api.slack.com/robots)"
      );
      expect(rewriteForLinkUnfurler(request)).toBeNull();
    });

    it("returns null for /loops/123", () => {
      const request = makeRequest(
        "/loops/123",
        "Slackbot 1.0 (+https://api.slack.com/robots)"
      );
      expect(rewriteForLinkUnfurler(request)).toBeNull();
    });

    it("returns null for /sign-in", () => {
      const request = makeRequest("/sign-in", "Twitterbot/1.0");
      expect(rewriteForLinkUnfurler(request)).toBeNull();
    });

    it("does not rewrite paths with sub-segments (e.g. /prds/abc/edit)", () => {
      const request = makeRequest(
        "/prds/abc/edit",
        "Slackbot 1.0 (+https://api.slack.com/robots)"
      );
      expect(rewriteForLinkUnfurler(request)).toBeNull();
    });

    it("does not rewrite paths with sub-segments (e.g. /artifacts/abc/comments)", () => {
      const request = makeRequest(
        "/artifacts/abc/comments",
        "facebookexternalhit/1.1"
      );
      expect(rewriteForLinkUnfurler(request)).toBeNull();
    });
  });

  describe("rewrites bot requests for artifact paths to /og/<slug>", () => {
    it("rewrites Slackbot request for /prds/<slug> to /og/<slug>", () => {
      const request = makeRequest(
        "/prds/my-prd-slug",
        "Slackbot 1.0 (+https://api.slack.com/robots)"
      );
      const response = rewriteForLinkUnfurler(request);

      expect(response).not.toBeNull();
      expect(response?.headers.get("x-middleware-rewrite")).toContain(
        "/og/my-prd-slug"
      );
    });

    it("rewrites Twitterbot request for /implementation-plans/<slug> to /og/<slug>", () => {
      const request = makeRequest(
        "/implementation-plans/plan-abc-123",
        "Twitterbot/1.0"
      );
      const response = rewriteForLinkUnfurler(request);

      expect(response).not.toBeNull();
      expect(response?.headers.get("x-middleware-rewrite")).toContain(
        "/og/plan-abc-123"
      );
    });

    it("rewrites facebookexternalhit request for /artifacts/<slug> to /og/<slug>", () => {
      const request = makeRequest(
        "/artifacts/artifact-xyz",
        "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
      );
      const response = rewriteForLinkUnfurler(request);

      expect(response).not.toBeNull();
      expect(response?.headers.get("x-middleware-rewrite")).toContain(
        "/og/artifact-xyz"
      );
    });

    it("rewrites LinkedInBot request for /issues/<slug> to /og/<slug>", () => {
      const request = makeRequest(
        "/issues/issue-42",
        "LinkedInBot/1.0 (compatible; +http://www.linkedin.com)"
      );
      const response = rewriteForLinkUnfurler(request);

      expect(response).not.toBeNull();
      expect(response?.headers.get("x-middleware-rewrite")).toContain(
        "/og/issue-42"
      );
    });

    it("rewrites WhatsApp request for /artifacts/<slug> to /og/<slug>", () => {
      const request = makeRequest(
        "/artifacts/whatsapp-test",
        "WhatsApp/2.23.1 A"
      );
      const response = rewriteForLinkUnfurler(request);

      expect(response).not.toBeNull();
      expect(response?.headers.get("x-middleware-rewrite")).toContain(
        "/og/whatsapp-test"
      );
    });

    it("rewrites TelegramBot request for /prds/<slug> to /og/<slug>", () => {
      const request = makeRequest(
        "/prds/telegram-slug",
        "TelegramBot (https://t.me/examplebot; 1.0)"
      );
      const response = rewriteForLinkUnfurler(request);

      expect(response).not.toBeNull();
      expect(response?.headers.get("x-middleware-rewrite")).toContain(
        "/og/telegram-slug"
      );
    });

    it("rewrites Discordbot request for /implementation-plans/<slug> to /og/<slug>", () => {
      const request = makeRequest(
        "/implementation-plans/discord-plan",
        "Discordbot/1.0 (+https://discordapp.com)"
      );
      const response = rewriteForLinkUnfurler(request);

      expect(response).not.toBeNull();
      expect(response?.headers.get("x-middleware-rewrite")).toContain(
        "/og/discord-plan"
      );
    });
  });

  describe("case-insensitive user agent matching", () => {
    it("matches lowercase slackbot", () => {
      const request = makeRequest("/prds/my-slug", "slackbot 1.0");
      const response = rewriteForLinkUnfurler(request);

      expect(response).not.toBeNull();
      expect(response?.headers.get("x-middleware-rewrite")).toContain(
        "/og/my-slug"
      );
    });

    it("matches mixed-case TWITTERBOT", () => {
      const request = makeRequest(
        "/artifacts/mixed-case-slug",
        "TWITTERBOT/1.0"
      );
      const response = rewriteForLinkUnfurler(request);

      expect(response).not.toBeNull();
      expect(response?.headers.get("x-middleware-rewrite")).toContain(
        "/og/mixed-case-slug"
      );
    });
  });
});
