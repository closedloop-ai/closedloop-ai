import { GITHUB_BRAND_MARK_FILLED_FLAG_KEY } from "@repo/api/src/types/github-brand-mark-filled-flag";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flagReads: [] as string[],
  enabled: undefined as boolean | undefined,
}));

/**
 * `@repo/analytics/client` reaches posthog-js, which has no resolvable ESM
 * subpath outside a bundler. The gate only asks it one question, so a stub that
 * records the key and answers it is the whole surface under test.
 */
vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (flag: string) => {
    mocks.flagReads.push(flag);
    return mocks.enabled === undefined
      ? undefined
      : { key: flag, enabled: mocks.enabled };
  },
}));

const { GitHubLogo } = await import("@/components/github-logo");
const { getSiteLinks } = await import("@/lib/site");

beforeEach(() => {
  mocks.flagReads = [];
  mocks.enabled = undefined;
});

/** lucide's outline glyph; the filled Invertocat carries neither marker. */
const OUTLINE_MARKERS = [/lucide-github/, /fill="none"/];

describe("the marketing site's GitHub mark", () => {
  // `getSiteLinks` hands `/docs` a rendered ELEMENT rather than rendering the
  // mark at a call site, so a sweep over JSX usages never sees it. This asserts
  // the record yields the gated component itself, not the raw lucide glyph it
  // used to hold.
  test("the site-links record carries the gated logo", () => {
    const githubLink = getSiteLinks("en").find(
      (link) => link.text === "GitHub"
    );

    expect(githubLink).toBeDefined();
    expect((githubLink?.icon as ReactElement | undefined)?.type).toBe(
      GitHubLogo
    );
  });

  // The closed-by-default state has to be byte-identical to what shipped, and
  // on four SERVER call sites that means the SERVER render must never emit the
  // filled mark — otherwise the first client paint disagrees with the HTML and
  // anonymous marketing traffic gets a hydration mismatch.
  test("a server render emits the outline even when the flag is open", () => {
    mocks.enabled = true;

    const html = renderToStaticMarkup(<GitHubLogo className="size-4" />);

    for (const marker of OUTLINE_MARKERS) {
      expect(html).toMatch(marker);
    }
    expect(html).toContain("size-4");
  });

  // Pins that the marketing reader forwards the shared constant to PostHog
  // unchanged and asks for exactly one flag. The two ports cannot NAME
  // different keys — both import the same literal — so that is not what this
  // protects; the literal itself is pinned in the registration ledger.
  test("asks PostHog for the one shared key", () => {
    renderToStaticMarkup(<GitHubLogo />);

    expect(mocks.flagReads).toEqual([GITHUB_BRAND_MARK_FILLED_FLAG_KEY]);
  });
});
