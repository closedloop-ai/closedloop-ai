/**
 * The Agents inventory honesty batch, at the surface it ships on.
 *
 * The COLUMN and LAYOUT swaps assert both sides of `agents-surface-honesty`:
 * they ship dark under ISS-4779, so "the screen is byte-for-byte what it is
 * today" is their flag-OFF contract.
 *
 * The SUMMARY STRIP has one side since ISS-9931 deleted its gate, so its cases
 * run flag-OFF only — a seeded flag there would tell the next reader the strip
 * still swaps on a key it no longer reads.
 *
 * ISS-5517 needs three states told apart, not two. A card reading `0` is
 * satisfied by "not fetched yet", by "the fetch failed", AND by a population
 * that genuinely has no components — which is why the settled true-zero case
 * below is not optional garnish: without it, "no `0` while loading" is equally
 * satisfied by a strip that has stopped counting at all.
 */

import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
} from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { makeComponent } from "../agent-component-fixtures";
import { AgentsGroupedList } from "../agents-grouped-list";

// The sd3 Tooltip renders in a portal that never mounts in jsdom; mock it so the
// name-lead trigger stays inline, matching the sibling suites.
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const HONESTY_FLAGS = [AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY] as const;

const COMPONENTS_LABEL = "Components";
const SOURCE_COLUMN_LABEL = "Source";
const LOADING_CAPTION = "Loading…";
const UNAVAILABLE_CAPTION = "Unavailable";
const POPULATION_CAPTION = "matched by the current filters";
const TABLE_LOADING_COPY = "Loading components…";
const TABLE_ERROR_COPY = /Couldn't load components/;
const EM_DASH = "—";
/** The lead column header, whose presence proves the table rendered at all. */
const COMPONENT_LEAD_HEADER_RE = /Component/;

const ONE_ROW: AgentComponent[] = [
  makeComponent({
    id: "uuid-cmd-1",
    name: "Code Review Command",
    kind: AgentComponentKind.Command,
  }),
];

function resolvedSource(items: AgentComponent[]): AgentComponentsDataSource {
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

/** A read that never settles — the first-paint state ISS-5517 is about. */
function pendingSource(): AgentComponentsDataSource {
  return {
    scope: "test",
    honorsDateWindow: false,
    list: () => new Promise<AgentComponentListResponse>(() => undefined),
    detail: () => Promise.reject(new Error("detail unused")),
  };
}

function failingSource(): AgentComponentsDataSource {
  return {
    scope: "test",
    honorsDateWindow: false,
    list: () => Promise.reject(new Error("inventory read failed")),
    detail: () => Promise.reject(new Error("detail unused")),
  };
}

function Wrapper({
  children,
  dataSource,
  enabledFlags,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
  enabledFlags?: readonly string[];
}) {
  return (
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

/**
 * The Components card's own DOM subtree. Scoped so a `0` elsewhere on the page
 * (a table cell, a facet count) can never satisfy or break an assertion about
 * what the CARD claims.
 */
function componentsCard(): HTMLElement {
  const card = screen.getByText(COMPONENTS_LABEL).closest("[data-slot='card']");
  if (!card) {
    throw new Error("Components summary card not found");
  }
  return card as HTMLElement;
}

describe("ISS-5517 — the summary strip over an uncounted population", () => {
  // `Wrapper` without `enabledFlags` still mounts the adapter, over an EMPTY
  // enabled set, so the flag resolves `false` rather than going unresolved — the
  // state every user shipped in. Restoring the gate reddens the two absences
  // below; the measured zero after them is their live-locator control and passes
  // either way.
  it("withholds the zero while loading even with the honesty flag off", async () => {
    render(
      <Wrapper dataSource={pendingSource()}>
        <AgentsGroupedList />
      </Wrapper>
    );

    expect(await screen.findByText(TABLE_LOADING_COPY)).toBeInTheDocument();
    const card = componentsCard();
    expect(card).toHaveTextContent(LOADING_CAPTION);
    expect(card).not.toHaveTextContent("0");
    expect(card).not.toHaveTextContent(POPULATION_CAPTION);
  });

  it("withholds the zero after a failed read even with the honesty flag off", async () => {
    render(
      <Wrapper dataSource={failingSource()}>
        <AgentsGroupedList />
      </Wrapper>
    );

    expect(await screen.findByText(TABLE_ERROR_COPY)).toBeInTheDocument();
    const card = componentsCard();
    expect(card).toHaveTextContent(EM_DASH);
    expect(card).toHaveTextContent(UNAVAILABLE_CAPTION);
    expect(card).not.toHaveTextContent("0");
    expect(card).not.toHaveTextContent(POPULATION_CAPTION);
    expect(card).not.toHaveTextContent(LOADING_CAPTION);
  });

  it("still prints a measured zero with the honesty flag off", async () => {
    render(
      <Wrapper dataSource={resolvedSource([])}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await waitFor(() =>
      expect(componentsCard()).toHaveTextContent(POPULATION_CAPTION)
    );
    const card = componentsCard();
    expect(card).toHaveTextContent("0");
    expect(card).not.toHaveTextContent(LOADING_CAPTION);
    expect(card).not.toHaveTextContent(UNAVAILABLE_CAPTION);
  });

  it("covers every always-present card, not only Components", async () => {
    render(
      <Wrapper dataSource={pendingSource()}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText(TABLE_LOADING_COPY);
    for (const label of [
      COMPONENTS_LABEL,
      "Invocations",
      AGENT_COMPONENT_AUTHORS_LABEL,
    ]) {
      const card = screen.getByText(label).closest("[data-slot='card']");
      expect(card).toHaveTextContent(LOADING_CAPTION);
      expect(card).not.toHaveTextContent("0");
    }
  });
});

describe("ISS-5530 — the KPI strip and the table's scroll plane", () => {
  it("lifts the strip out of the horizontally scrolling container", async () => {
    render(
      <Wrapper
        dataSource={resolvedSource(ONE_ROW)}
        enabledFlags={HONESTY_FLAGS}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findAllByText("Code Review Command");
    expect(componentsCard().closest(".overflow-auto")).toBeNull();
  });

  it("leaves the strip inside that container while the gate is closed", async () => {
    render(
      <Wrapper dataSource={resolvedSource(ONE_ROW)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findAllByText("Code Review Command");
    expect(componentsCard().closest(".overflow-auto")).not.toBeNull();
  });
});

describe("ISS-5528 — Source as an opt-in column", () => {
  it("drops Source from the default column set", async () => {
    render(
      <Wrapper
        dataSource={resolvedSource(ONE_ROW)}
        enabledFlags={HONESTY_FLAGS}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findAllByText("Code Review Command");
    // The lead column it duplicated is still there — this drops the echo, not
    // the identity, and an assertion that only checked Source's absence would
    // also pass on a table that failed to render any header at all.
    expect(
      screen.getByRole("columnheader", { name: COMPONENT_LEAD_HEADER_RE })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: SOURCE_COLUMN_LABEL })
    ).toBeNull();
  });

  it("keeps Source in the default column set while the gate is closed", async () => {
    render(
      <Wrapper dataSource={resolvedSource(ONE_ROW)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findAllByText("Code Review Command");
    expect(
      screen.getByRole("columnheader", { name: SOURCE_COLUMN_LABEL })
    ).toBeInTheDocument();
  });

  // BOTH cases above resolve the gate BEFORE mount, which is the one
  // arrangement that cannot exercise the late-resolve path PostHog actually
  // takes on web — and `AppCoreStoryProviders` captures its flag adapter in
  // `useState` on mount, so no rerender here can flip it. The restore-effect
  // half of this fix is therefore pinned one layer down, against the hook that
  // owns it: see "re-applies a default-hidden set that changed after mount" and
  // its PERSISTING sibling in
  // packages/app/shared/hooks/__tests__/use-persisted-table-view-state.test.tsx,
  // and in e2e/agents-surface-honesty.spec.ts.
});
