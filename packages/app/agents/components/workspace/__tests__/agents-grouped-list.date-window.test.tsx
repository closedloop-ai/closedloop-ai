/**
 * ISS-6888 / FEA-3178 — the Agents summary cards' period-over-period delta, and
 * the data-source capability that governs whether it is computed at all.
 *
 * Split out of `agents-grouped-list.test.tsx` by ISS-6888: that file is on the
 * shrink-only grandfather list, and this is a self-contained responsibility —
 * every case here drives the SAME control (pick a bounded window) and asserts on
 * the SAME artifact (the signed-percentage delta chip). The mount harness is
 * shared with the parent suite through `agents-grouped-list-harness` so the two
 * files cannot drift into mounting the component differently.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  FIXTURE_COMPONENTS,
  AGENT_COMPONENTS_HTTP_SCOPE as HTTP_SCOPE,
  makeComponent,
  periodOverPeriodDataSource,
} from "@repo/app/agents/components/workspace/agent-component-fixtures";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AgentsGroupedList } from "../agents-grouped-list";
import { testDataSource, Wrapper } from "./agents-grouped-list-harness";

const RE_LAST_60_DAYS = /last 60 days/i;
const RE_AGENTS_TAB = /agents/i;
// FEA-3178: MetricCard delta chip renders `{positive?"+":""}{delta}%`.
const RE_PLUS_100_PCT = /\+100%/;
const RE_MINUS_50_PCT = /-50%/;
// Any signed-percentage delta chip — used to assert NONE render.
const RE_ANY_PCT_CHIP = /[+-]\d+%/;

describe("AgentsGroupedList period-over-period delta", () => {
  it("renders a period-over-period delta chip with the right sign when a window is selected", async () => {
    const user = userEvent.setup();
    // Current window: 2 components, 30 invocations total. Previous window: 1
    // component, 15 invocations. Components: (2-1)/1 = +100%. Invocations:
    // (30-15)/15 = +100%. Authors: current {alice,bob}=2 vs previous
    // {alice}=1 = +100%.
    const current = [
      makeComponent({
        id: "cur-1",
        name: "Current A",
        invocations: 20,
        collaborators: ["alice"],
      }),
      makeComponent({
        id: "cur-2",
        name: "Current B",
        invocations: 10,
        collaborators: ["bob"],
      }),
    ];
    const previous = [
      makeComponent({
        id: "prev-1",
        name: "Prev A",
        invocations: 15,
        collaborators: ["alice"],
      }),
    ];

    render(
      <Wrapper dataSource={periodOverPeriodDataSource(current, previous)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // Select a bounded window so the preceding query fires.
    await screen.findByText("Current A");
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));

    // At least one +100% delta chip renders (Components / Invocations /
    // Authors all moved +100%). The chip text carries the sign + percentage.
    await waitFor(() => {
      expect(screen.getAllByText(RE_PLUS_100_PCT).length).toBeGreaterThan(0);
    });
  });

  it("renders a NEGATIVE delta when the current window shrank vs the prior period", async () => {
    const user = userEvent.setup();
    // Invocations: current 10 vs previous 20 ⇒ (10-20)/20 = -50%.
    const current = [
      makeComponent({ id: "cur-1", name: "Current A", invocations: 10 }),
    ];
    const previous = [
      makeComponent({ id: "prev-1", name: "Prev A", invocations: 20 }),
    ];

    render(
      <Wrapper dataSource={periodOverPeriodDataSource(current, previous)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Current A");
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));

    await waitFor(() => {
      expect(screen.getAllByText(RE_MINUS_50_PCT).length).toBeGreaterThan(0);
    });
  });

  it("shows NO delta chip for the All window (no prior period to compare)", async () => {
    // The default window is "All": the preceding query is disabled (never sends
    // endDate), so no baseline exists and no delta chip renders — never a
    // fabricated placeholder. Assert no signed-percentage chip is present.
    render(
      <Wrapper
        dataSource={testDataSource(
          FIXTURE_COMPONENTS,
          undefined,
          HTTP_SCOPE,
          true
        )}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("My Orchestrator Agent");
    expect(screen.queryByText(RE_ANY_PCT_CHIP)).not.toBeInTheDocument();
  });

  // ISS-6888 — the DECLARED capability is what gates the delta, not the source's
  // scope string. These two cases run the SAME component over the SAME two
  // populations and differ in exactly one input, `honorsDateWindow`, so neither
  // can pass on the fixture's rows alone: flip the declaration the wrong way and
  // one of them fails. Before ISS-6888 this pair could not have been written —
  // the suppression keyed off `scope === "agent-components:http"`, so proving it
  // meant naming the desktop source, which is precisely how the gate outlived
  // the reason for it.
  it("suppresses the delta on a source that does NOT honor the date window", async () => {
    const user = userEvent.setup();
    // A source that ignores the bounds answers the preceding query with the
    // current window's rows, so any delta it produced would be fabricated.
    const current = [
      makeComponent({ id: "cap-cur", name: "Capability A", invocations: 10 }),
    ];
    const previous = [
      makeComponent({ id: "cap-prev", name: "Capability A", invocations: 20 }),
    ];

    render(
      <Wrapper
        dataSource={periodOverPeriodDataSource(current, previous, {
          honorsDateWindow: false,
        })}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Capability A");
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));

    // Give the (suppressed) preceding query a chance to have run: assert the
    // summary is rendered but carries no signed-percentage delta chip.
    await waitFor(() => {
      expect(screen.getByText("Capability A")).toBeInTheDocument();
    });
    expect(screen.queryByText(RE_ANY_PCT_CHIP)).not.toBeInTheDocument();
  });

  it("renders the delta on those SAME populations once the source declares it honors the window", async () => {
    const user = userEvent.setup();
    // Byte-for-byte the populations of the case above — 10 now vs 20 before, so
    // a real baseline reads -50%. The ONLY difference is the declaration.
    const current = [
      makeComponent({ id: "cap-cur", name: "Capability A", invocations: 10 }),
    ];
    const previous = [
      makeComponent({ id: "cap-prev", name: "Capability A", invocations: 20 }),
    ];

    render(
      <Wrapper
        dataSource={periodOverPeriodDataSource(current, previous, {
          honorsDateWindow: true,
        })}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Capability A");
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));

    await waitFor(() => {
      expect(screen.getAllByText(RE_MINUS_50_PCT).length).toBeGreaterThan(0);
    });
  });

  it("facet-filters the PREVIOUS window the same way as the current before computing the delta", async () => {
    const user = userEvent.setup();
    // Current window (Subagent kind): 1 subagent, 10 invocations.
    // Previous window: 1 subagent (10 invocations) PLUS an unrelated Command.
    // With the Agents (Subagent) type-tab active, BOTH the current and the
    // previous populations must be narrowed to Subagents. The facet-filtered
    // previous Invocations = 20 (the subagent only), so the delta is
    // (10-20)/20 = -50%. If the previous window were left UNfiltered, its
    // Invocations would be 20 (subagent) + 30 (command) = 50, giving
    // (10-50)/50 = -80% — a different, apples-to-oranges number. Asserting the
    // -50% chip proves the previous population is facet-filtered like-for-like.
    const current = [
      makeComponent({
        id: "cur-sub",
        name: "Current Subagent",
        kind: AgentComponentKind.Subagent,
        invocations: 10,
      }),
    ];
    const previous = [
      makeComponent({
        id: "prev-sub",
        name: "Prev Subagent",
        kind: AgentComponentKind.Subagent,
        invocations: 20,
      }),
      makeComponent({
        id: "prev-cmd",
        name: "Prev Command",
        kind: AgentComponentKind.Command,
        invocations: 30,
      }),
    ];

    render(
      <Wrapper dataSource={periodOverPeriodDataSource(current, previous)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // Narrow to the Agents (Subagent) type-tab AND select a bounded window.
    await screen.findByText("Current Subagent");
    await user.click(screen.getByRole("radio", { name: RE_AGENTS_TAB }));
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));

    // The Invocations delta reflects the FACET-FILTERED previous population
    // (subagent only, 20 → -50%), never the unfiltered previous total (50).
    await waitFor(() => {
      expect(screen.getAllByText(RE_MINUS_50_PCT).length).toBeGreaterThan(0);
    });
  });
});
