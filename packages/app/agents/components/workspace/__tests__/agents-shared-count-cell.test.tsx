import {
  type AgentComponent,
  AgentComponentKind,
  AgentMetricMode,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentsTable } from "../agents-table";

/**
 * ISS-6384 — the Agents catalog's private, unexported `NumberCell` moving onto
 * the shared `CountCell`.
 *
 * This is the migration where the flag actually changes what a reader sees, and
 * the change is the ticket's own house rule: a count of exactly `0` renders the
 * shared em-dash named "No invocations" rather than a literal `0`, matching
 * Branches. Both positions of the flag are asserted on every case that moves,
 * because "renders a dash" proves nothing unless the other arm provably renders
 * the number.
 */

// The sd3 Tooltip renders in a portal that never mounts in jsdom; mock it so the
// name-lead trigger stays inline, matching the sibling suites.
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-default",
    slug: "subagent::uuid-default",
    name: "acme/refactor-agent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 1234,
    sessions: 8,
    versionCount: 3,
    locPerDollar: 2.5,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2020-01-01T00:00:00.000Z",
    lastSeenAt: "2020-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderTable({
  sharedCells,
  item = makeComponent(),
}: {
  sharedCells: boolean;
  item?: AgentComponent;
}) {
  return render(
    <AppCoreStoryProviders
      enabledFlags={
        sharedCells ? [ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY] : []
      }
    >
      <AgentsTable
        items={[item]}
        metricMode={AgentMetricMode.LocPerDollar}
        mode="expanded"
        onSort={vi.fn()}
        sortBy="name"
        sortDir="asc"
      />
    </AppCoreStoryProviders>
  );
}

describe("Agents catalog count columns (ISS-6384)", () => {
  it("renders a true zero as the named empty value", () => {
    renderTable({
      sharedCells: true,
      item: makeComponent({ invocations: 0, sessions: 0 }),
    });

    expect(screen.queryByText("0")).not.toBeInTheDocument();
    // Zero and unknown share the glyph and never the words.
    expect(screen.getByText("No invocations")).toBeInTheDocument();
    expect(screen.getByText("No sessions")).toBeInTheDocument();
  });

  it("renders that same zero as a literal 0 before the shared cell", () => {
    // The flag-OFF arm of the case above, and the reason it means anything: the
    // absence assertions there would pass against a table rendering nothing at
    // all unless this arm proves the numbers were being painted.
    renderTable({
      sharedCells: false,
      item: makeComponent({ invocations: 0, sessions: 0 }),
    });

    expect(screen.getAllByText("0")).toHaveLength(2);
    expect(screen.queryByText("No invocations")).not.toBeInTheDocument();
  });

  it("tells an unknown count apart from a zero one", () => {
    const item = makeComponent({ invocations: null, sessions: 0 });
    renderTable({ sharedCells: true, item });

    expect(screen.getByText("invocations unavailable")).toBeInTheDocument();
    expect(screen.getByText("No sessions")).toBeInTheDocument();
    // The two must not collapse onto one sentence.
    expect(screen.queryByText("No invocations")).not.toBeInTheDocument();
    expect(screen.queryByText("sessions unavailable")).not.toBeInTheDocument();
  });

  it("keeps grouped digits when a real count renders", () => {
    // Adopting the shared cell must not cost the column its thousands
    // separators — `12847` as a bare digit run is a legibility regression, and
    // the hand-rolled cell it replaces formatted through `NUMBER_FORMAT`.
    renderTable({
      sharedCells: true,
      item: makeComponent({ invocations: 1234 }),
    });

    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("names a count of one in the singular", () => {
    renderTable({
      sharedCells: true,
      item: makeComponent({ invocations: 1, sessions: 1 }),
    });

    expect(screen.getByText("1 invocation")).toBeInTheDocument();
    expect(screen.getByText("1 session")).toBeInTheDocument();
  });
});
