/**
 * ISS-5151 — the app owns the page outline, so a third-party embed's own `h1`s
 * must not arrive as extra top-level headings. WCAG 2.2 SC 1.3.1.
 *
 * The fixture reproduces what Clerk's embedded account UI actually emits: two
 * `h1`s of its own inside the container the app mounts it into. That shape is
 * taken from the installed `@clerk/ui` 1.6.5 bundle (its heading primitive's
 * call sites pass `as="h1"` as a literal) and from the production DOM the issue
 * recorded — NOT from the component under test, which is what would make this
 * suite agree with itself instead of with the defect.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DEMOTED_HEADING_ATTRIBUTE,
  ThirdPartyHeadingScope,
} from "../third-party-heading-scope";

/** What the embed puts in the page: its own navbar title and page title. */
const EmbeddedAccountUi = () => (
  <div>
    <h1>Account</h1>
    <h1>Profile details</h1>
  </div>
);

/** The page around the embed: the app's real, single page heading. */
const SettingsPageShell = ({ children }: { children: React.ReactNode }) => (
  <div>
    <h1>Settings</h1>
    {children}
  </div>
);

describe("ThirdPartyHeadingScope", () => {
  it("leaves the page with exactly one level-1 heading, and it is the page's own", async () => {
    render(
      <SettingsPageShell>
        <ThirdPartyHeadingScope>
          <EmbeddedAccountUi />
        </ThirdPartyHeadingScope>
      </SettingsPageShell>
    );

    // The positive half: the surviving h1 is the RIGHT one. A bare length check
    // would also pass on a page that rendered no headings at all.
    await waitFor(() => {
      expect(
        screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)
      ).toEqual(["Settings"]);
    });
  });

  it("exposes the embed's headings one level below the page heading", async () => {
    render(
      <SettingsPageShell>
        <ThirdPartyHeadingScope>
          <EmbeddedAccountUi />
        </ThirdPartyHeadingScope>
      </SettingsPageShell>
    );

    // Demoted, not deleted: the embed's headings must still be reachable by
    // heading navigation, or the fix has traded one a11y defect for a worse one.
    await waitFor(() => {
      expect(
        screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
      ).toEqual(["Account", "Profile details"]);
    });
  });

  it("demotes headings the embed mounts AFTER the scope has mounted", async () => {
    // The embed renders asynchronously and swaps its whole content on every
    // inner navigation (Account → Security → …), so a one-shot pass on mount
    // would demote the first page only.
    const { container } = render(
      <ThirdPartyHeadingScope>
        <div data-testid="embed-root" />
      </ThirdPartyHeadingScope>
    );
    await waitFor(() =>
      expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0)
    );

    const embedRoot = screen.getByTestId("embed-root");
    const late = container.ownerDocument.createElement("h1");
    late.textContent = "Security";
    embedRoot.append(late);

    await waitFor(() => {
      expect(
        screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
      ).toEqual(["Security"]);
    });
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  it("honours an explicit level so a nested embed does not skip one", async () => {
    render(
      <ThirdPartyHeadingScope level={3}>
        <EmbeddedAccountUi />
      </ThirdPartyHeadingScope>
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
      ).toEqual(["Account", "Profile details"]);
    });
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });

  it("re-exposes already-demoted headings when the requested level changes", async () => {
    // The marker must record the level demoted TO, not merely that a demotion
    // happened: a scope re-rendered at a new `level` that skipped every marked
    // heading would leave the whole embed announcing the OLD level forever.
    const { rerender } = render(
      <ThirdPartyHeadingScope level={2}>
        <EmbeddedAccountUi />
      </ThirdPartyHeadingScope>
    );
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2)
    );

    rerender(
      <ThirdPartyHeadingScope level={3}>
        <EmbeddedAccountUi />
      </ThirdPartyHeadingScope>
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
      ).toEqual(["Account", "Profile details"]);
    });
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });

  it("marks each heading once, so the observer's re-entrant passes are idempotent", async () => {
    const { container } = render(
      <ThirdPartyHeadingScope>
        <EmbeddedAccountUi />
      </ThirdPartyHeadingScope>
    );

    await waitFor(() =>
      expect(
        container.querySelectorAll(`[${DEMOTED_HEADING_ATTRIBUTE}]`)
      ).toHaveLength(2)
    );
  });

  it("leaves headings outside the scope alone", async () => {
    render(
      <SettingsPageShell>
        <ThirdPartyHeadingScope>
          <EmbeddedAccountUi />
        </ThirdPartyHeadingScope>
      </SettingsPageShell>
    );

    // The negative above ("no h1 from the embed") needs this sibling positive:
    // a scope that demoted the whole document would satisfy the count check and
    // destroy the page's own outline.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Settings" })
      ).not.toHaveAttribute(DEMOTED_HEADING_ATTRIBUTE)
    );
  });
});
