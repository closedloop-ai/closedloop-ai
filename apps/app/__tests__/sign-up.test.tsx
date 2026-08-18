import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import Page, {
  generateMetadata,
} from "../app/(unauthenticated)/sign-up/[[...sign-up]]/page";

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ host: "app.closedloop.ai" })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

test("Sign Up Page", () => {
  const { container } = render(<Page />);
  expect(container).toBeDefined();
});

// FEA-632 sends unauthenticated visitors (including link-unfurler bots) to
// sign-up, so this page must resolve document OG metadata from redirect_url
// like the sign-in page does — otherwise link previews show "Create an
// account" instead of the document title.
test("generateMetadata resolves document metadata from redirect_url", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ title: "My Feature", status: "IN_PROGRESS" })
  );

  const metadata = await generateMetadata({
    searchParams: Promise.resolve({
      redirect_url: "https://app.closedloop.ai/acme/features/FEA-3826",
    }),
  });

  expect(metadata.title).toBe("My Feature | Closedloop.ai");
});

test("generateMetadata falls back to sign-up metadata without redirect_url", async () => {
  const metadata = await generateMetadata({
    searchParams: Promise.resolve({}),
  });

  expect(metadata.title).toBe("Create an account | Closedloop.ai");
});

// /sign-up?redirect_url=/a&redirect_url=/b arrives as string[] — must fall
// back to the page metadata instead of throwing (previously a 500).
test("generateMetadata falls back for a repeated redirect_url param", async () => {
  const metadata = await generateMetadata({
    searchParams: Promise.resolve({ redirect_url: ["/a", "/b"] }),
  });

  expect(metadata.title).toBe("Create an account | Closedloop.ai");
});
