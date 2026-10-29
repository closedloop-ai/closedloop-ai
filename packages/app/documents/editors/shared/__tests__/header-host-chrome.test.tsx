import { DocumentHostProvider } from "@repo/app/documents/components/document-host-context";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Header } from "../header";

function mount(hideHeaderBreadcrumbs = false) {
  const navigation = createMemoryNavigation();
  render(
    <NavigationProvider adapter={navigation.adapter}>
      <DocumentHostProvider
        hideHeaderBreadcrumbs={hideHeaderBreadcrumbs}
        orgSlug="acme"
      >
        <Header
          afterBreadcrumbs={<button type="button">Favorite</button>}
          breadcrumbs={[
            { label: "Documents", href: "/documents" },
            { label: "Release notes" },
          ]}
          moreMenu={<button type="button">More options</button>}
        >
          <button type="button">Export Markdown</button>
        </Header>
      </DocumentHostProvider>
    </NavigationProvider>
  );
}

describe("document header host chrome", () => {
  it("retains Web breadcrumb navigation by default", () => {
    mount();
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Documents" })).toBeTruthy();
  });

  it("uses native shell breadcrumbs while preserving editor actions and heading", () => {
    mount(true);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Release notes", level: 1 })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Favorite" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More options" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export Markdown" })
    ).toBeTruthy();
  });
});
