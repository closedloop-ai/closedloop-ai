import { beforeEach, describe, expect, test, vi } from "vitest";

const locale = vi.hoisted(() => ({ source: "en" }));
vi.mock("@repo/internationalization/languine.json", () => ({
  default: { locale },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/en/docs",
  useParams: vi.fn(),
  useRouter: vi.fn(),
}));

// The config aliases only the generated MDX input to support/docs-source.ts.
// Keep the real Fumadocs loader and our source configuration under test.

import { WebRootProvider } from "@/components/web-root-provider";
import { getDocsSource } from "@/lib/docs";
import { publicPathname } from "@/lib/public-pathname";
import { getSiteLinks, localize } from "@/lib/site";

beforeEach(() => {
  locale.source = "en";
});

describe("rewriteDefault docs paths", () => {
  test("hands Fumadocs the normalized Next pathname", () => {
    const framework = WebRootProvider({ children: null });
    expect(framework.props.usePathname()).toBe("/docs");
  });

  test.each([
    ["/en", "/"],
    ["/en/docs", "/docs"],
    ["/en/docs/guide", "/docs/guide"],
    ["/de/docs", "/de/docs"],
    ["/pricing", "/pricing"],
    ["/english/docs", "/english/docs"],
  ])("normalizes %s to %s", (input, output) => {
    expect(publicPathname(input)).toBe(output);
  });

  test.each([
    ["en", "/docs", "/"],
    ["de", "/de/docs", "/de"],
  ])(
    "aligns %s source pages, site links and home navigation",
    (language, docsPath, homePath) => {
      const source = getDocsSource(language);
      expect(source.getPage([])?.url).toBe(docsPath);
      expect(source.getPage(["guide"])?.url).toBe(`${docsPath}/guide`);
      expect(source.getPageTree().children).toEqual(
        expect.arrayContaining([expect.objectContaining({ url: docsPath })])
      );
      expect(getSiteLinks(language)[0].url).toBe(docsPath);
      expect(localize(language, "/")).toBe(homePath);
    }
  );

  test("follows the configured source locale instead of hardcoding English", () => {
    locale.source = "de";
    expect(publicPathname("/de/docs")).toBe("/docs");
    expect(publicPathname("/en/docs")).toBe("/en/docs");
    expect(getDocsSource("de").getPage([])?.url).toBe("/docs");
    expect(getDocsSource("en").getPage([])?.url).toBe("/en/docs");
    expect(getSiteLinks("de")[0].url).toBe("/docs");
    expect(localize("de", "/")).toBe("/");
    expect(localize("en", "/")).toBe("/en");
  });
});
