// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MobileNav } from "@/app/[locale]/components/site-header-mobile";

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => undefined,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("opens the named navigation sheet without console warnings", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  render(
    <MobileNav
      docsHref="/en/docs"
      githubUrl="https://github.test/closedloop-ai"
      resourcesHref="/en/resources"
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

  expect(screen.getByRole("dialog", { name: "Site navigation" })).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Documentation" }).getAttribute("href")
  ).toBe("/en/docs");
  expect(warning.mock.calls).toEqual([]);
  expect(error.mock.calls).toEqual([]);
});
