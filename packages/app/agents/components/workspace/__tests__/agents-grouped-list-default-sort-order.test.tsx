/**
 * ISS-5005 regression guard — the Agents catalog's RENDERED default row order.
 *
 * ISS-5005 was the catalog landing view burying every used component under
 * 2,000+ zero-invocation internals: the table defaulted to Component-ascending,
 * and because internal tools are underscore-prefixed, page one was entirely
 * `_add_comment_to_issue`-style rows reading 0 invocations while the summary
 * card above claimed 292,875.
 *
 * The fix promotes the default sort to a usage-bearing column behind
 * `agents-default-sort-usage`. Its two halves are already covered:
 *   - the hook's default + saved-view migration:
 *     `packages/app/agents/hooks/__tests__/use-agent-components-view-state-default-sort.test.tsx`
 *   - the pure comparator:
 *     `packages/app/agents/lib/__tests__/agent-component-sort-group.test.ts`
 *
 * The WIRING between them was not. `AgentsGroupedList` calls
 * `sortAgentComponentRows(allRows, sortKey, sortDir)` (agents-grouped-list.tsx,
 * the sort→filter→paginate pipeline), and nothing asserted the rendered order.
 * Hardcoding that call to `AgentComponentSortKey.Name` would regress the ticket
 * exactly as filed while every test in the repo stayed green.
 *
 * Both flag branches are asserted on the SAME fixture, so the test cannot pass
 * by the gate being unavailable in jsdom: with the flag off the underscore-
 * prefixed zero-invocation internal must lead, and with it on the most-invoked
 * component must. A hardcoded sort key fails one branch or the other.
 *
 * Lives beside `agents-grouped-list.test.tsx` rather than inside it because that
 * file is on the `noExcessiveLinesPerFile` grandfather list (shrink-only), and
 * follows the existing `agents-grouped-list.summary-cards.test.tsx` split.
 */

import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
} from "@repo/api/src/types/agent-component";
import { makeComponent } from "@repo/app/agents/components/workspace/agent-component-fixtures";
import { AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentsGroupedList } from "../agents-grouped-list";

// The ISS-5005 shape: an underscore-prefixed internal that wins Component-asc
// while carrying no usage.
//
// The names are chosen so the usage ordering matches NEITHER alphabetical
// direction — a fixture whose most-used row is also alphabetically last makes
// Invocations-desc indistinguishable from Name-desc, and the assertion then
// passes against a hardcoded Name sort (verified: it did, before this fixture
// was corrected). With the most-used row sitting alphabetically in the MIDDLE:
//
//   usage-desc  → [Alpha(900), Beta(40), _add(0)]
//   name-asc    → [_add,       Alpha,    Beta]
//   name-desc   → [Beta,       Alpha,    _add]
//
// all three are distinct, so each assertion below can only be satisfied by the
// sort it names.
const ZERO_USE_INTERNAL_NAME = "_add_comment_to_issue";
const MOST_USED_NAME = "Alpha Retrieval Agent";
const MIDDLE_NAME = "Beta Formatting Skill";

// `makeComponent` is the shared cross-surface factory in
// `agent-component-fixtures.ts` (ISS-4496) — the same one the parent
// `agents-grouped-list.test.tsx` uses. Every field this fixture depends on
// (name, kind, invocations, sessions) is overridden explicitly below, so the
// shared defaults only supply the shape.
const FIXTURE: AgentComponent[] = [
  makeComponent({
    id: "uuid-internal-zero",
    name: ZERO_USE_INTERNAL_NAME,
    kind: AgentComponentKind.Tool,
    invocations: 0,
    sessions: 0,
  }),
  makeComponent({
    id: "uuid-most-used",
    name: MOST_USED_NAME,
    kind: AgentComponentKind.Subagent,
    invocations: 900,
    sessions: 120,
  }),
  makeComponent({
    id: "uuid-mid",
    name: MIDDLE_NAME,
    kind: AgentComponentKind.Skill,
    invocations: 40,
    sessions: 6,
  }),
];

function testDataSource(items: AgentComponent[]): AgentComponentsDataSource {
  return {
    scope: "test",
    list: () =>
      Promise.resolve({
        items,
        total: items.length,
      } satisfies AgentComponentListResponse),
    detail: () =>
      Promise.reject(new Error("detail unused in default-sort tests")),
  };
}

function Wrapper({
  children,
  dataSource,
  enabledFlags,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
  enabledFlags: readonly string[];
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
 * The rendered data rows, in DOM order, as their component names.
 *
 * Rows are the `.group.grid` elements the agents table renders (the same hook
 * the sibling `agents-table` suite uses to separate data rows from the header
 * row, which is not a `.group`).
 */
function renderedRowNames(): string[] {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>(".group.grid")
  );
  const names: string[] = [];
  for (const row of rows) {
    for (const candidate of [
      ZERO_USE_INTERNAL_NAME,
      MIDDLE_NAME,
      MOST_USED_NAME,
    ]) {
      if (row.textContent?.includes(candidate)) {
        names.push(candidate);
        break;
      }
    }
  }
  return names;
}

afterEach(() => {
  // Isolation between the two cases does NOT come from this call: both mounts
  // omit `persistKey`, so `usePersistedTableViewState` resolves `storageKey` to
  // null and both its restore-read and persist-write short-circuit — the hook
  // never touches localStorage here, and each `render()` gets fresh state.
  // The clear is defensive only, so that adding a `persistKey` to these mounts
  // later cannot leak a saved view from one flag branch into the other.
  globalThis.localStorage.clear();
});

describe("AgentsGroupedList default sort order (ISS-5005)", () => {
  it("leads with the most-invoked component when the usage default sort is enabled", async () => {
    render(
      <Wrapper
        dataSource={testDataSource(FIXTURE)}
        enabledFlags={[AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY]}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText(MOST_USED_NAME);

    // The whole point of the ticket: page one answers "which components are
    // used". Assert the full order, not just the head, so a comparator that
    // merely floated one row to the top would not satisfy it.
    expect(renderedRowNames()).toEqual([
      MOST_USED_NAME,
      MIDDLE_NAME,
      ZERO_USE_INTERNAL_NAME,
    ]);
  });

  it("leads with the alphabetically-first internal when the flag is off", async () => {
    render(
      <Wrapper dataSource={testDataSource(FIXTURE)} enabledFlags={[]}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText(MOST_USED_NAME);

    // The pre-ISS-5005 behavior, still the closed-by-default branch. Asserting
    // it pins the gate itself: if the default sort were hardcoded to the usage
    // column (rather than resolved from the flag), THIS case would fail — which
    // is what stops the test above from passing for the wrong reason.
    expect(renderedRowNames()).toEqual([
      ZERO_USE_INTERNAL_NAME,
      MOST_USED_NAME,
      MIDDLE_NAME,
    ]);
  });
});
