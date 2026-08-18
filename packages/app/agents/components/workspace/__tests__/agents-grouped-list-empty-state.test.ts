import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import {
  type AgentComponentFilters,
  DEFAULT_AGENT_COMPONENT_FILTERS,
} from "../../../hooks/use-agent-components-filter-state";
import { AgentsTimeRange } from "../../../lib/agents-timeframe";
import { emptyStateMessage, pluginHarnessScope } from "../agents-grouped-list";

// ---------------------------------------------------------------------------
// FEA-4086: honest installed-plugins inventory empty-state copy.
//
// The Plugins tab is an installed-plugins inventory (the desktop
// component-scanner projects installed agent_packs into kind:"plugin" rows; web
// surfaces the same rows). Its empty state must say exactly that — nothing is
// installed — scoped to the active harness when a single harness facet is the
// only narrowing, and must NOT lie by borrowing the "no components match the
// current filters" copy for a state the user never filtered into.
//
// The full component wiring (tab click → honest copy + Packs pointer) is
// covered as an integration test in agents-grouped-list.test.tsx; these are the
// pure copy/scoping helpers, kept in a sibling file so the grandfathered
// integration file does not grow.
// ---------------------------------------------------------------------------

const ALL_TYPES = "all" as const;

function filtersWith(
  overrides: Partial<AgentComponentFilters>
): AgentComponentFilters {
  return { ...DEFAULT_AGENT_COMPONENT_FILTERS, ...overrides };
}

describe("pluginHarnessScope", () => {
  it("names the harness when a single harness facet is the ONLY narrowing on the Plugins tab", () => {
    expect(
      pluginHarnessScope(
        AgentComponentKind.Plugin,
        filtersWith({ harnesses: [Harness.Claude] })
      )
    ).toBe("Claude");
    expect(
      pluginHarnessScope(
        AgentComponentKind.Plugin,
        filtersWith({ harnesses: [Harness.Codex] })
      )
    ).toBe("Codex");
  });

  it("claims no scope with no harness facet (inventory spans every harness)", () => {
    expect(
      pluginHarnessScope(AgentComponentKind.Plugin, filtersWith({}))
    ).toBeUndefined();
  });

  it("claims no scope with several harnesses selected (no single harness to name)", () => {
    expect(
      pluginHarnessScope(
        AgentComponentKind.Plugin,
        filtersWith({ harnesses: [Harness.Claude, Harness.Codex] })
      )
    ).toBeUndefined();
  });

  it("claims no scope for a lone `Both` facet — 'Multiple harnesses' is not one nameable harness (FEA-4086)", () => {
    // A `Both`-only facet is a real narrowing, but "No plugins installed for
    // Multiple harnesses." would misread as a compound scope, so the suffix is
    // skipped and the copy falls back to the unscoped "No plugins installed."
    expect(
      pluginHarnessScope(
        AgentComponentKind.Plugin,
        filtersWith({ harnesses: [Harness.Both] })
      )
    ).toBeUndefined();
  });

  it("treats a whitespace-only search box as no search (parity with filterAgentComponentRows)", () => {
    // FEA-4086: a single space must not count as a real filter here while the
    // membership predicate trims it away — otherwise the space empties the list
    // yet the copy still claims a scoped install state.
    expect(
      pluginHarnessScope(
        AgentComponentKind.Plugin,
        filtersWith({ harnesses: [Harness.Claude], search: "   " })
      )
    ).toBe("Claude");
  });

  it("claims no scope when another facet or search also narrows the view", () => {
    expect(
      pluginHarnessScope(
        AgentComponentKind.Plugin,
        filtersWith({ harnesses: [Harness.Claude], collaborators: ["alice"] })
      )
    ).toBeUndefined();
    expect(
      pluginHarnessScope(
        AgentComponentKind.Plugin,
        filtersWith({ harnesses: [Harness.Claude], search: "foo" })
      )
    ).toBeUndefined();
  });

  it("claims no scope on any tab other than Plugins", () => {
    expect(
      pluginHarnessScope(
        AgentComponentKind.Mcp,
        filtersWith({ harnesses: [Harness.Claude] })
      )
    ).toBeUndefined();
    expect(
      pluginHarnessScope(
        ALL_TYPES,
        filtersWith({ harnesses: [Harness.Claude] })
      )
    ).toBeUndefined();
  });
});

describe("emptyStateMessage (Plugins tab honesty)", () => {
  it("says nothing is installed on an empty Plugins tab with no narrowing", () => {
    expect(
      emptyStateMessage(
        AgentComponentKind.Plugin,
        AgentsTimeRange.All,
        false,
        true,
        undefined
      )
    ).toBe("No plugins installed.");
  });

  it("scopes the honest copy to the harness when a single harness facet narrows it", () => {
    // hasActiveFacetOrSearch is true (a harness facet IS active), but the honest
    // install copy still wins and carries the harness scope.
    expect(
      emptyStateMessage(
        AgentComponentKind.Plugin,
        AgentsTimeRange.All,
        true,
        true,
        "Claude"
      )
    ).toBe("No plugins installed for Claude.");
  });

  it("falls back to the generic filter copy when an owner/source/search filter is active (not an install state)", () => {
    // isHonestPluginsEmpty is false because the narrowing is a real filter, not
    // the single-harness case — so the copy must NOT claim nothing is installed.
    expect(
      emptyStateMessage(
        AgentComponentKind.Plugin,
        AgentsTimeRange.All,
        true,
        false,
        undefined
      )
    ).toBe("No components match the current filters.");
  });

  it("leaves the observed-kind empty copy unchanged (not a plugin install state)", () => {
    expect(
      emptyStateMessage(
        AgentComponentKind.Skill,
        AgentsTimeRange.All,
        false,
        false,
        undefined
      )
    ).toBe("No skills yet.");
  });

  it("words a WINDOWED empty Plugins tab as usage, never 'installed' (FEA-4086)", () => {
    // A windowed Plugins tab is emptied by `dropZeroWindowUsage` (zero in-window
    // usage), not by an empty inventory, so `isHonestPluginsEmpty` is false and
    // the copy must speak to usage — claiming "installed" here would lie about a
    // still-installed but unused plugin. Cover every windowed range.
    expect(
      emptyStateMessage(
        AgentComponentKind.Plugin,
        AgentsTimeRange.Last30Days,
        false,
        false,
        undefined
      )
    ).toBe("No plugins used in the last 30 days.");
    expect(
      emptyStateMessage(
        AgentComponentKind.Plugin,
        AgentsTimeRange.Last60Days,
        false,
        false,
        undefined
      )
    ).toBe("No plugins used in the last 60 days.");
    expect(
      emptyStateMessage(
        AgentComponentKind.Plugin,
        AgentsTimeRange.Last90Days,
        false,
        false,
        undefined
      )
    ).toBe("No plugins used in the last 90 days.");
  });
});
