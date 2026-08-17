import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentSessionsListContent } from "../agent-sessions-list";
import { mixedAgentSessionListFixtures } from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";
import {
  A11Y_THEMES,
  HookBackedListProbe,
  renderWithNav,
} from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

describe("SyncedSessionsTable — list load, empty/loading, and a11y states", () => {
  it("loads list data through useAgentSessions, fixture ApiAdapter, date revival, and rendered UI", async () => {
    renderWithNav(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions",
            respond: () => ({
              items: mixedAgentSessionListFixtures,
              total: mixedAgentSessionListFixtures.length,
              viewerScope: "self",
            }),
          },
        ]}
      >
        <HookBackedListProbe />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Named Session")).toBeInTheDocument();
    expect(screen.getByText("external-name-fallback")).toBeInTheDocument();
    expect(
      screen.getAllByText("closedloop-ai/repo-fallback").length
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole("link")[0]).toHaveAttribute(
      "href",
      "/sessions/session-name"
    );
  });

  it("renders loading and filtered-empty list states from the shared list body", () => {
    const { rerender } = renderWithNav(
      <AgentSessionsListContent
        getSessionHref={(item) => `/sessions/${item.id}`}
        isLoading
        items={[]}
      />
    );

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();

    rerender(
      <AgentSessionsListContent
        emptySignals={{ isUnavailable: false, hasActiveFilters: true }}
        getSessionHref={(item) => `/sessions/${item.id}`}
        isLoading={false}
        items={[]}
      />
    );

    // FEA-4181: an active filter over zero rows is the filtered-empty reason.
    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No sessions match the current filters. Try clearing or widening a filter."
      )
    ).toBeInTheDocument();
  });

  // PRD-536 §5: an org that has never connected a desktop agent gets the
  // onboarding CTA on zero rows; a connected org (or unknown signal) keeps the
  // neutral filters message; and the presence of rows suppresses both.
  it("shows the onboarding CTA on zero rows when no agent has ever connected", () => {
    renderWithNav(
      <AgentSessionsListContent
        getSessionHref={(item) => `/sessions/${item.id}`}
        hasConnectedAgent={false}
        isLoading={false}
        items={[]}
        onboardingAction={<a href="/acme/settings">Connect a compute target</a>}
      />
    );

    expect(screen.getByText("No sessions synced yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Connect a compute target with desktop agent-session sync enabled to start syncing sessions."
      )
    ).toBeInTheDocument();
    // The onboarding empty state renders the host-supplied call-to-action, not
    // just prose (PRD-536 §5 review: an onboarding screen needs the button).
    expect(
      screen.getByRole("link", { name: "Connect a compute target" })
    ).toHaveAttribute("href", "/acme/settings");
    // The onboarding branch must NOT show the filtered copy.
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
  });

  it("shows the neutral nothing-yet state on zero rows when a connected org has no filters active", () => {
    renderWithNav(
      <AgentSessionsListContent
        emptySignals={{ isUnavailable: false, hasActiveFilters: false }}
        getSessionHref={(item) => `/sessions/${item.id}`}
        hasConnectedAgent
        isLoading={false}
        items={[]}
      />
    );

    // FEA-4181: hydrated read, no filter, connected org, zero rows ⇒ the genuine
    // "nothing yet" state — not a filters claim (nothing is filtering) and not
    // the onboarding CTA (the org has connected).
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
    // A connected org must never be shown the onboarding CTA.
    expect(
      screen.queryByText("No sessions synced yet")
    ).not.toBeInTheDocument();
  });

  it("renders the table (never an empty state) when rows are present regardless of the connected-agent signal", () => {
    renderWithNav(
      <AgentSessionsListContent
        getSessionHref={(item) => `/sessions/${item.id}`}
        hasConnectedAgent={false}
        isLoading={false}
        items={mixedAgentSessionListFixtures}
      />
    );

    // Rows short-circuit before the empty-state branch: no empty copy shows.
    expect(
      screen.queryByText("No sessions synced yet")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
    expect(screen.getByText("Session")).toBeInTheDocument();
  });

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps shared sessions table critical a11y and contrast clean in %s theme", async (theme) => {
    const { container } = renderWithNav(
      <A11yThemeRoot theme={theme}>
        <SyncedSessionsTable
          getSessionHref={(item) => `/sessions/${item.id}`}
          items={mixedAgentSessionListFixtures}
        />
      </A11yThemeRoot>
    );

    await expectCriticalAxeClean(container);
    expectElementContrast(screen.getByText("Session"), {
      background: themeBackground(theme),
      label: `sessions row label ${theme}`,
    });
  });

  it.each([
    [
      "loading",
      () => (
        <AgentSessionsListContent
          getSessionHref={(item) => `/sessions/${item.id}`}
          isLoading
          items={[]}
        />
      ),
      () => document.querySelector(".animate-pulse"),
    ],
    [
      "filtered-empty",
      () => (
        <AgentSessionsListContent
          emptySignals={{ isUnavailable: false, hasActiveFilters: true }}
          getSessionHref={(item) => `/sessions/${item.id}`}
          isLoading={false}
          items={[]}
        />
      ),
      () => screen.getByText("No matching sessions"),
    ],
    [
      // ISS-5770 retargeted this case from the removed `Awaiting input`
      // qualifier chip to the Status chip that carries the same fact: the API
      // projects `Waiting` from `awaitingInputSince`
      // (`session-status-projection.ts`, FEA-4301), so the row still announces
      // it — in one place now instead of two.
      "status-chip-row",
      () => (
        <SyncedSessionsTable
          getSessionHref={(item) => `/sessions/${item.id}`}
          items={mixedAgentSessionListFixtures}
        />
      ),
      () => screen.getAllByText("Waiting")[0],
    ],
  ])("keeps shared sessions %s state a11y and contrast clean", async (_state, renderElement, getTarget) => {
    for (const theme of A11Y_THEMES) {
      const { container, unmount } = renderWithNav(
        <A11yThemeRoot theme={theme}>{renderElement()}</A11yThemeRoot>
      );

      const target = getTarget();
      expect(target).toBeInstanceOf(Element);
      await expectCriticalAxeClean(container);
      expectElementContrast(target as Element, {
        background: themeBackground(theme),
        label: `shared sessions ${_state} ${theme}`,
      });
      unmount();
    }
  });
});

// ISS-6239: this body is the component that used to default the kebab ON, so a
// host mounting it WITHOUT the (now deleted) `showRowActions` prop is the exact
// shape that reinstated the menu ISS-5315 removed. The sibling guards pin the
// web adapter and the shared presentational table; neither reaches here.
describe("AgentSessionsListContent — row overflow menu removed (ISS-6239)", () => {
  it("renders no per-row actions trigger when mounted with no host wiring", () => {
    renderWithNav(
      <AgentSessionsListContent
        getSessionHref={(item) => `/sessions/${item.id}`}
        isLoading={false}
        items={mixedAgentSessionListFixtures}
      />
    );

    // The rows themselves rendered — otherwise "no trigger" would be vacuously
    // true for an empty table.
    expect(screen.getAllByRole("link").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Session actions" })
    ).not.toBeInTheDocument();
  });
});
