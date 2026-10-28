import { describe, expect, it } from "vitest";
import { GitHubConnectAction } from "../github-connect-action";
import {
  GITHUB_CONNECT_COPY,
  GITHUB_CONNECT_PROMPT_COPY,
} from "../github-connect-copy";

const allActions = Object.values(GitHubConnectAction);
const promptActions = allActions.filter(
  (action) => action !== GitHubConnectAction.SignUp
);

describe("GITHUB_CONNECT_COPY", () => {
  it("has an entry for every GitHubConnectAction", () => {
    for (const action of allActions) {
      expect(GITHUB_CONNECT_COPY[action]).toBeDefined();
    }
  });

  it("gives every entry non-empty ctaLabel, gatedMetricExplanation, and deliveryBannerExplanation strings", () => {
    for (const action of allActions) {
      const copy = GITHUB_CONNECT_COPY[action];
      expect(typeof copy.ctaLabel).toBe("string");
      expect(copy.ctaLabel.length).toBeGreaterThan(0);
      expect(typeof copy.gatedMetricExplanation).toBe("string");
      expect(copy.gatedMetricExplanation.length).toBeGreaterThan(0);
      expect(typeof copy.deliveryBannerExplanation).toBe("string");
      expect(copy.deliveryBannerExplanation.length).toBeGreaterThan(0);
    }
  });

  it("shares the Connect verb between SignUp and Connect (ISS-7866)", () => {
    expect(GITHUB_CONNECT_COPY[GitHubConnectAction.SignUp].ctaLabel).toBe(
      GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel
    );
    expect(GITHUB_CONNECT_COPY[GitHubConnectAction.SignUp].ctaLabel).toBe(
      "Connect GitHub"
    );
  });

  it("gives Reconnect a distinct verb from Connect", () => {
    expect(GITHUB_CONNECT_COPY[GitHubConnectAction.Reconnect].ctaLabel).toBe(
      "Reconnect GitHub"
    );
    expect(
      GITHUB_CONNECT_COPY[GitHubConnectAction.Reconnect].ctaLabel
    ).not.toBe(GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel);
  });

  it("words the card placement's ask as the ISS-11476 prototype draws it", () => {
    expect(GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardCtaLabel).toBe(
      "Connect to GitHub"
    );
    expect(GITHUB_CONNECT_COPY[GitHubConnectAction.SignUp].cardCtaLabel).toBe(
      GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardCtaLabel
    );
    expect(
      GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardSupportingCopy
    ).toBe("to see sessions tied to PRs.");
  });

  it("supplies no card wording for the repair the prototype never drew", () => {
    // The prototype is the ONLY authority for this placement's words, and it
    // draws first-time connect alone. A card wording for a repair would be one
    // this repo wrote itself, so the entry carries none and the placement falls
    // back to the approved verb (tamsinb + Codex review on #8169).
    const reconnect = GITHUB_CONNECT_COPY[GitHubConnectAction.Reconnect];
    expect(reconnect.cardCtaLabel).toBeUndefined();
    expect(reconnect.cardSupportingCopy).toBeUndefined();
    expect(reconnect.cardCtaLabel ?? reconnect.ctaLabel).toBe(
      "Reconnect GitHub"
    );
  });

  it("carries the same verb from the CTA into the section banner explanation", () => {
    expect(
      GITHUB_CONNECT_COPY[GitHubConnectAction.Reconnect]
        .deliveryBannerExplanation
    ).toContain("Reconnect");
    expect(
      GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].deliveryBannerExplanation
    ).toContain("Connect");
  });
});

describe("GITHUB_CONNECT_PROMPT_COPY", () => {
  it("has an entry for every signed-in prompt action (excludes SignUp)", () => {
    for (const action of promptActions) {
      expect(GITHUB_CONNECT_PROMPT_COPY[action]).toBeDefined();
    }
    expect(
      Object.hasOwn(GITHUB_CONNECT_PROMPT_COPY, GitHubConnectAction.SignUp)
    ).toBe(false);
  });

  it("gives every prompt entry a non-empty heading, body, ctaLabel, and footnote", () => {
    for (const action of promptActions) {
      const copy = GITHUB_CONNECT_PROMPT_COPY[action];
      expect(typeof copy.heading).toBe("string");
      expect(copy.heading.length).toBeGreaterThan(0);
      expect(typeof copy.body).toBe("string");
      expect(copy.body.length).toBeGreaterThan(0);
      expect(typeof copy.ctaLabel).toBe("string");
      expect(copy.ctaLabel.length).toBeGreaterThan(0);
      expect(typeof copy.footnote).toBe("string");
      expect(copy.footnote.length).toBeGreaterThan(0);
    }
  });

  it("uses the same browser-handoff verb for every prompt action's CTA", () => {
    const ctaLabels = promptActions.map(
      (action) => GITHUB_CONNECT_PROMPT_COPY[action].ctaLabel
    );
    expect(new Set(ctaLabels).size).toBe(1);
    expect(ctaLabels[0]).toBe("Continue with GitHub");
  });

  it("gives Connect a flow-position eyebrow and Reconnect none (a repair has no position to report)", () => {
    expect(
      GITHUB_CONNECT_PROMPT_COPY[GitHubConnectAction.Connect].eyebrow
    ).toBe("One more step · Required");
    expect(
      GITHUB_CONNECT_PROMPT_COPY[GitHubConnectAction.Reconnect].eyebrow
    ).toBeUndefined();
  });
});
