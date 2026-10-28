import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import PrivacyPolicyPage, {
  generateMetadata as generatePrivacyMetadata,
} from "@/app/[locale]/(site)/legal/privacy/page";
import TermsOfServicePage, {
  generateMetadata as generateTermsMetadata,
} from "@/app/[locale]/(site)/legal/terms/page";

const H1_TEXT = /<h1[^>]*>([^<]*)<\/h1>/;
const TAG = /<[^>]*>/g;

// A page under `[locale]` may read its route params, and the terms page does to
// localize its link to the privacy policy. Each row therefore supplies a thunk
// rather than the component itself, so a sync and an async page render the same
// way here and neither signature leaks into the assertions below.
const localeParams = () => Promise.resolve({ locale: "en" });

async function renderPage(
  page: () => ReactElement | Promise<ReactElement>
): Promise<string> {
  return renderToStaticMarkup(await page());
}

describe.each([
  {
    page: () => <PrivacyPolicyPage />,
    generateMetadata: generatePrivacyMetadata,
    description:
      "Learn how Closedloop.ai handles personal information through its website, desktop application, and software development platform.",
    documentTitle: "Closedloop.ai Privacy Policy",
    path: "/legal/privacy",
  },
  {
    page: () => TermsOfServicePage({ params: localeParams() }),
    generateMetadata: generateTermsMetadata,
    description:
      "Read the terms governing use of the Closedloop.ai website, desktop application, and software development platform.",
    documentTitle: "Closedloop.ai Terms of Service",
    path: "/legal/terms",
  },
])("$path", ({ page, generateMetadata, description, documentTitle, path }) => {
  test("renders exactly one h1 carrying its title", async () => {
    const markup = await renderPage(page);

    expect(markup.match(H1_TEXT)?.[1]).toBe(documentTitle);
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup.replace(TAG, "").trim()).toContain(documentTitle);
  });

  test("the privacy policy is indexable, while the unfinished terms page is not", async () => {
    const metadata = await generateMetadata();

    if (path === "/legal/privacy") {
      expect(metadata.robots).toBeUndefined();
    } else {
      expect(metadata.robots).toEqual({ follow: true, index: false });
    }
  });

  test("privacy page states that we do not sell personal information", async () => {
    if (path !== "/legal/privacy") {
      return;
    }

    const markup = (await renderPage(page)).replace(TAG, " ");

    expect(markup.toLowerCase()).toContain(
      "we do not sell personal information"
    );
  });

  test("advertises its own og:url so the resolved link has a URL identity", async () => {
    const metadata = await generateMetadata();

    expect(metadata.openGraph?.url).toBe(path);
  });

  test("describes itself with the meta description it was submitted with", async () => {
    const metadata = await generateMetadata();

    expect(metadata.description).toBe(description);
    expect(metadata.openGraph?.description).toBe(description);
  });
});
