/**
 * ISS-5527 — an Agents group header must not report a page slice as a kind.
 *
 * `groupAgentComponentRows` runs over `pageRows`, so `group.items.length` is a
 * count of THIS page. On a 48-page inventory that made "Commands 3" mean three
 * of however many the org has, and the number moved as the reader paged while
 * the Components card beside it held steady. `session-grouping.ts` wrote the
 * convention down and `session-detail-table.tsx` defaults `showGroupCount` to false
 * since; this table was the half that never did.
 *
 * Both halves of the defect are covered, because suppressing the count alone
 * would leave "Workflows" sitting over nothing — a header for a kind with no row
 * on the page, which still reads as an assertion about the org.
 *
 * Group-by is applied through the real View menu rather than a seeded store, so
 * the production path (menu → `useAgentComponentsViewState` → `AgentsGroupedList`
 * → `AgentsTable` → `GridTable`) is the thing under test.
 */

import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
} from "@repo/api/src/types/agent-component";
import { AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { makeComponent } from "../agent-component-fixtures";
import { AgentsGroupedList } from "../agents-grouped-list";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const HONESTY_FLAGS = [AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY] as const;

const VIEW_MENU_TRIGGER_NAME = /^view$/i;
const GROUP_BY_TYPE_OPTION = "Type";

/**
 * The header words are pinned as INDEPENDENT literals rather than read from
 * `kindPlural`, so a rename of the plural map cannot keep this suite green while
 * the screen changes. The count is likewise written out rather than derived from
 * the fixture's length. `GroupSectionHeader` puts the label and the count in
 * adjacent spans with no whitespace between them, so the accessible name a
 * counted header computes to is `Commands1` — unspaced — and `Commands` is the
 * name of the same header once the count is gone.
 */
const COMMANDS_HEADER = "Commands";
const COMMANDS_HEADER_WITH_PAGE_COUNT = "Commands1";
/** A kind with NO row in the fixture — the "Workflows 0" header of the ticket. */
const ABSENT_KIND_HEADER = "Workflows";
const ABSENT_KIND_HEADER_WITH_PAGE_COUNT = `${ABSENT_KIND_HEADER}0`;

/** One row, one kind: every other kind's group is empty on this page. */
const ONE_COMMAND: AgentComponent[] = [
  makeComponent({
    id: "uuid-cmd-1",
    name: "Code Review Command",
    kind: AgentComponentKind.Command,
  }),
];

function testDataSource(items: AgentComponent[]): AgentComponentsDataSource {
  return {
    scope: "test",
    honorsDateWindow: false,
    list: () =>
      Promise.resolve({
        items,
        total: items.length,
      } satisfies AgentComponentListResponse),
    detail: () => Promise.reject(new Error("detail unused")),
  };
}

function Wrapper({
  children,
  enabledFlags,
}: {
  children: ReactNode;
  enabledFlags?: readonly string[];
}) {
  return (
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <AgentComponentsDataSourceProvider
        dataSource={testDataSource(ONE_COMMAND)}
      >
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

async function groupByType(user: UserEvent) {
  // `GridTable` renders the grid AND the narrow-surface card list, so the row
  // name is in the tree twice; the wait is for the row to EXIST, not for one.
  await screen.findAllByText("Code Review Command");
  await user.click(
    screen.getByRole("button", { name: VIEW_MENU_TRIGGER_NAME })
  );
  await user.click(
    await screen.findByRole("radio", { name: GROUP_BY_TYPE_OPTION })
  );
  await user.keyboard("{Escape}");
}

describe("ISS-5527 — page-scoped group headers", () => {
  it("names the kind without reporting the page slice as its size", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper enabledFlags={HONESTY_FLAGS}>
        <AgentsGroupedList />
      </Wrapper>
    );
    await groupByType(user);

    // The header is still there and still names the kind — the count is what
    // goes, not the band.
    expect(
      await screen.findByRole("button", { name: COMMANDS_HEADER })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: COMMANDS_HEADER_WITH_PAGE_COUNT })
    ).toBeNull();
  });

  it("drops the header for a kind that put no row on this page", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper enabledFlags={HONESTY_FLAGS}>
        <AgentsGroupedList />
      </Wrapper>
    );
    await groupByType(user);

    await screen.findByRole("button", { name: COMMANDS_HEADER });
    expect(
      screen.queryByRole("button", { name: ABSENT_KIND_HEADER })
    ).toBeNull();
  });

  it("keeps both page-scoped counts and empty kind headers while the gate is closed", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <AgentsGroupedList />
      </Wrapper>
    );
    await groupByType(user);

    expect(
      await screen.findByRole("button", {
        name: COMMANDS_HEADER_WITH_PAGE_COUNT,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: ABSENT_KIND_HEADER_WITH_PAGE_COUNT })
    ).toBeInTheDocument();
  });
});
