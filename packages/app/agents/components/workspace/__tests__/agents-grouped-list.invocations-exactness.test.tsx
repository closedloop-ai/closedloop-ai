import {
  type AgentComponent,
  AgentComponentKind,
} from "@repo/api/src/types/agent-component";
import { INVOCATIONS_DELTA_NOT_COMPARABLE } from "@repo/api/src/utils/agent-component-summary-aggregate";
import {
  makeComponent,
  periodOverPeriodDataSource,
} from "@repo/app/agents/components/workspace/agent-component-fixtures";
import { AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentsGroupedList } from "../agents-grouped-list";

/**
 * ISS-6205 — the Invocations card's DELTA when the two windows were not counted
 * the same way.
 *
 * Exactness is a property of each window's own DATA: a version-skewed producer's
 * legacy plugin can be in the current window and not the preceding one. Dividing
 * an approximated current by a measured baseline reports the change in COUNTING
 * METHOD as a change in usage — the fabricated-delta failure FEA-3178 exists to
 * prevent, reached by a new route.
 *
 * Lives beside `agents-grouped-list.test.tsx` rather than inside it because that
 * file is at its `noExcessiveLinesPerFile` grandfather ceiling and is shrink-only.
 */

// FEA-3178: MetricCard renders its delta chip as `{positive?"+":""}{delta}%`.
const RE_PLUS_100_PCT = /\+100%/;
const RE_ANY_PCT_CHIP = /[+-]\d+%/;
const RE_LAST_60_DAYS = /last 60 days/i;

function Wrapper({
  children,
  dataSource,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
}) {
  return (
    <AppCoreStoryProviders
      enabledFlags={[AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY]}
    >
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

/**
 * The Invocations card's own subtree. Scoping matters: the Components and
 * Authors cards keep their deltas on these fixtures, so a page-wide
 * `queryByText` for a percentage chip would be answered by a different card.
 */
function invocationsCard(): HTMLElement {
  const card = screen
    .getByRole("button", { name: "About Invocations" })
    .closest("[data-slot='card']");
  if (!(card instanceof HTMLElement)) {
    throw new Error("Could not find the Invocations summary card");
  }
  return card;
}

/** A plugin whose 500 the reduction must count, with the parentage varied. */
function currentPlugin(packIds: string[] | undefined): AgentComponent {
  return makeComponent({
    id: "cur-plugin",
    slug: "plugin::current",
    name: "Current Plugin",
    kind: AgentComponentKind.Plugin,
    invocations: 500,
    ...(packIds ? { packIds } : {}),
  });
}

/** A child-kind row that is NOT this plugin's child under either shape. */
function currentSkill(packIds: string[] | undefined): AgentComponent {
  return makeComponent({
    id: "cur-skill",
    slug: "skill::current",
    name: "Current Skill",
    kind: AgentComponentKind.Skill,
    invocations: 300,
    ...(packIds ? { packIds } : {}),
  });
}

/** The preceding window: one plugin, known parentage, no children in view. */
const PREVIOUS_WINDOW: AgentComponent[] = [
  makeComponent({
    id: "prev-plugin",
    slug: "plugin::previous",
    name: "Prev Plugin",
    kind: AgentComponentKind.Plugin,
    invocations: 400,
    packIds: ["prev-pack"],
  }),
];

async function selectBoundedWindow(): Promise<void> {
  const user = userEvent.setup();
  await screen.findByText("Current Plugin");
  await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));
}

describe("AgentsGroupedList Invocations delta under mixed exactness (ISS-6205)", () => {
  // Both cases below reduce to the SAME numbers — current 800, previous 400,
  // i.e. +100% — and differ ONLY in whether the current window's parentage is
  // knowable. That is what makes them a real A/B: the suppression below cannot
  // be credited to a missing card, a query that never resolved, or different
  // arithmetic.
  it("renders the Invocations delta when BOTH windows were counted exactly", async () => {
    render(
      <Wrapper
        dataSource={periodOverPeriodDataSource(
          // `cur-pack` is never represented by a child row (the skill belongs to
          // `other-pack`), so the plugin is counted for a KNOWN reason: exact.
          [currentPlugin(["cur-pack"]), currentSkill(["other-pack"])],
          PREVIOUS_WINDOW
        )}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await selectBoundedWindow();

    await waitFor(() => {
      expect(invocationsCard()).toHaveTextContent(RE_PLUS_100_PCT);
    });
    // Pin the total the delta was computed from, so the suppressed case cannot
    // differ by arithmetic rather than by exactness.
    expect(invocationsCard()).toHaveTextContent("800");
  });

  it("suppresses the Invocations delta when only the current window is inexact", async () => {
    render(
      <Wrapper
        dataSource={periodOverPeriodDataSource(
          // The same two rows — but a version-skewed producer emitted no
          // `packIds`, so the canonical contract's fallback drops the plugin's
          // 500 and the remaining 300 is published as a known undercount.
          [currentPlugin(undefined), currentSkill(undefined)],
          PREVIOUS_WINDOW
        )}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await selectBoundedWindow();

    // Wait for the card to REACH its inexact state — that only happens once the
    // reduction has run over the loaded population, so the absence asserted next
    // is a decision the component made rather than a render that never arrived.
    await waitFor(() => {
      expect(invocationsCard()).toHaveTextContent("some calls may be missing");
    });
    expect(invocationsCard()).toHaveTextContent("300");
    expect(invocationsCard()).not.toHaveTextContent(RE_ANY_PCT_CHIP);
    // The slot is FILLED, not left empty. A hole beside three sibling cards
    // that did compare reads as "no change"; this says which of the two the
    // reader is looking at.
    expect(invocationsCard()).toHaveTextContent(
      INVOCATIONS_DELTA_NOT_COMPARABLE
    );
  });

  // ISS-6205 code review (whitlockk): exactness is not the whole comparability
  // question. Both windows below are EXACT and both are right — the same plugin
  // is dropped as represented in the current window (its child is in view) and
  // counted as the sole record in the preceding one (that child had no prior
  // usage, so a windowed query returns no row for it). 300 against 400 is a
  // -25% chip made of two differently-covered populations. Checking exactness
  // alone renders that chip; carrying the per-plugin coverage across the pair is
  // what withholds it.
  it("suppresses the Invocations delta when the same plugin was covered differently in each window", async () => {
    render(
      <Wrapper
        dataSource={periodOverPeriodDataSource(
          [
            SHARED_PLUGIN_CURRENT,
            makeComponent({
              id: "cur-shared-child",
              slug: "skill::shared-child",
              name: "Current Child",
              kind: AgentComponentKind.Skill,
              invocations: 300,
              packIds: [SHARED_PACK_ID],
            }),
          ],
          [SHARED_PLUGIN_PREVIOUS]
        )}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await selectBoundedWindow();

    await waitFor(() => {
      expect(invocationsCard()).toHaveTextContent(
        INVOCATIONS_DELTA_NOT_COMPARABLE
      );
    });
    // Both windows reduced EXACTLY, so neither caveat is shown — the comparison
    // alone is withheld. Without this the test would pass on the inexact path
    // above rather than on the coverage mismatch it names.
    expect(invocationsCard()).not.toHaveTextContent(
      "some calls may be missing"
    );
    expect(invocationsCard()).toHaveTextContent("300");
    expect(invocationsCard()).not.toHaveTextContent(RE_ANY_PCT_CHIP);
  });
});

/** The pack both shared-plugin fixtures below belong to. */
const SHARED_PACK_ID = "shared-pack";

/**
 * One plugin identity, seen in BOTH windows under the same org-level `slug` —
 * which is what lets the pair notice it was reduced two different ways.
 */
const SHARED_PLUGIN_CURRENT: AgentComponent = makeComponent({
  id: "cur-shared-plugin",
  slug: "plugin::shared",
  name: "Current Plugin",
  kind: AgentComponentKind.Plugin,
  invocations: 500,
  packIds: [SHARED_PACK_ID],
});

const SHARED_PLUGIN_PREVIOUS: AgentComponent = makeComponent({
  id: "prev-shared-plugin",
  slug: "plugin::shared",
  name: "Prev Plugin",
  kind: AgentComponentKind.Plugin,
  invocations: 400,
  packIds: [SHARED_PACK_ID],
});
