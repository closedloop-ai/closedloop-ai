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
import { mixedAgentSessionListFixtures } from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";
import {
  HookBackedListProbe,
  renderWithNav,
} from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

describe("SyncedSessionsTable — data and accessibility", () => {
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

  it.each([A11yTheme.Light, A11yTheme.Dark])(
    "keeps the live table critical a11y and contrast clean in %s theme",
    async (theme) => {
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
      expectElementContrast(screen.getAllByText("Active")[0], {
        background: themeBackground(theme),
        label: `sessions status chip ${theme}`,
      });
    }
  );
});
