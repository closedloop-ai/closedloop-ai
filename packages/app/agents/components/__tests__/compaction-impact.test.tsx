import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowCompactionImpactData } from "@repo/app/agents/lib/session-types";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { CompactionImpact } from "../compaction-impact";

// FEA-3967: the compaction KPI tiles must render through the canonical
// design-system `MetricCard`, not the retired parallel `WorkflowStatTile`.
//
// Two layers guard this. (1) A structural import guard parses the source with
// the TypeScript compiler API and asserts the module imports `MetricCard` and
// does NOT import `WorkflowStatTile` (or its module path). DOM-slot assertions
// alone cannot prove the migration — the old `WorkflowStatTile` emitted the
// same `card`/`card-description`/`card-title` slots, so swapping the import
// back would leave slot checks green (whitlockk). The AST guard fails the moment
// the parallel tile is reintroduced. (2) Behavioral render tests assert the
// value/label/caption route correctly and that the plain count renders in full
// digits (matching Insights), not compact notation.

const COMPONENT_PATH = join(import.meta.dirname, "..", "compaction-impact.tsx");

const data: WorkflowCompactionImpactData = {
  totalCompactions: 74,
  tokensRecovered: 12_500,
  sessionsWithCompactions: 3,
  totalSessions: 8,
  perSession: [
    { sessionId: "session-a", compactions: 40 },
    { sessionId: "session-b", compactions: 34 },
  ],
};

/** Module specifiers of every top-level `import` declaration in a source file. */
function importedModuleSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** Names bound by the module's top-level import declarations. */
function importedNames(path: string): Set<string> {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

describe("CompactionImpact source imports (FEA-3967 migration guard)", () => {
  it("imports the canonical MetricCard", () => {
    const specifiers = importedModuleSpecifiers(COMPONENT_PATH);
    const names = importedNames(COMPONENT_PATH);

    expect(names.has("MetricCard")).toBe(true);
    expect(
      specifiers.some((spec) => spec.endsWith("/primitives/metric-card"))
    ).toBe(true);
  });

  it("does not reintroduce the retired WorkflowStatTile", () => {
    const specifiers = importedModuleSpecifiers(COMPONENT_PATH);
    const names = importedNames(COMPONENT_PATH);

    expect(names.has("WorkflowStatTile")).toBe(false);
    expect(specifiers.some((spec) => spec.includes("workflow-stat-tile"))).toBe(
      false
    );
  });
});

describe("CompactionImpact render", () => {
  it("routes label, value, and caption into the MetricCard slots", () => {
    render(<CompactionImpact data={data} />);

    const totalLabel = screen.getByText("Total compactions");
    const totalCard = totalLabel.closest("[data-slot='card']");
    expect(totalCard).not.toBeNull();
    expect(
      totalCard?.querySelector("[data-slot='card-title']")?.textContent
    ).toContain("74");

    // The "N of M sessions compacted" caption describes the compaction count,
    // so it belongs on the Total compactions card, not Recovered tokens.
    expect(
      totalCard?.querySelector("[data-slot='card-content']")?.textContent
    ).toContain("3 of 8 sessions compacted");

    expect(screen.getByText("Recovered tokens")).toBeInTheDocument();
  });

  it("renders the plain compaction count in full digits, not compact notation", () => {
    render(<CompactionImpact data={{ ...data, totalCompactions: 1400 }} />);

    const card = screen
      .getByText("Total compactions")
      .closest("[data-slot='card']");
    const value = card?.querySelector("[data-slot='card-title']")?.textContent;
    // Insights runs plain counts through full-digit formatting (1,400), and
    // MetricCard's own `formatMetricValue` does the same. A regression that
    // pre-formats the count with `formatCompactNumber` would render "1.4K".
    expect(value).toContain("1,400");
    expect(value).not.toContain("1.4K");
  });

  it("keeps the enclosing Section heading", () => {
    render(<CompactionImpact data={data} />);

    // The KPI tiles sit inside the shared `Section`; converging the cards must
    // not drop the section's own title.
    expect(screen.getByText("Compaction impact")).toBeInTheDocument();
  });
});

/**
 * ISS-9749 wiring, gate ON. `WorkflowCompactionImpactData` types both counts as
 * required numbers, so in-process nothing here is ever absent — but the shape
 * arrives as a parsed API payload, which is a trust boundary the types do not
 * constrain, so the nullish arms below are reachable and cast in deliberately.
 */
describe("CompactionImpact under metric-card-hide-unavailable", () => {
  it("keeps both cards for a real zero", () => {
    renderGated({ ...data, totalCompactions: 0, tokensRecovered: 0 });

    expect(screen.getByText("Total compactions")).toBeInTheDocument();
    expect(screen.getByText("Recovered tokens")).toBeInTheDocument();
    const card = screen
      .getByText("Total compactions")
      .closest("[data-slot='card']");
    expect(
      card?.querySelector("[data-slot='card-title']")?.textContent
    ).toContain("0");
  });

  it("retires only the absent card and keeps its rowmate", () => {
    renderGated(withAbsent({ totalCompactions: null }));

    expect(screen.queryByText("Total compactions")).not.toBeInTheDocument();
    expect(screen.getByText("Recovered tokens")).toBeInTheDocument();
  });

  /**
   * The Recovered tokens half, which only reddens while the availability check
   * runs on the RAW count: `formatCompactNumber` turns an absent one into "0",
   * and a card asked to hide on that string would keep a fabricated zero
   * instead (whitlockk review on #6914).
   */
  it("retires the absent Recovered tokens card, not a formatted zero", () => {
    renderGated(withAbsent({ tokensRecovered: null }));

    expect(screen.queryByText("Recovered tokens")).not.toBeInTheDocument();
    expect(screen.getByText("Total compactions")).toBeInTheDocument();
  });

  /**
   * ISS-9730 acceptance 3. Both counts absent would retire every card, so the
   * row keeps today's render rather than collapsing to a bare gap.
   */
  it("keeps the whole row when both counts are absent", () => {
    renderGated(withAbsent({ totalCompactions: null, tokensRecovered: null }));

    expect(screen.getByText("Total compactions")).toBeInTheDocument();
    expect(screen.getByText("Recovered tokens")).toBeInTheDocument();
    expect(screen.getByText("Compaction impact")).toBeInTheDocument();
    expect(screen.getByText("session-a")).toBeInTheDocument();
  });

  it("keeps that same absent card with the gate off", () => {
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <CompactionImpact data={withAbsent({ totalCompactions: null })} />
      </FeatureFlagAdapterProvider>
    );

    expect(screen.getByText("Total compactions")).toBeInTheDocument();
  });
});

function renderGated(impact: WorkflowCompactionImpactData) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY],
      })}
    >
      <CompactionImpact data={impact} />
    </FeatureFlagAdapterProvider>
  );
}

/** The same payload as it can actually arrive over the wire. */
type WireCompactionImpact = Omit<
  WorkflowCompactionImpactData,
  "totalCompactions" | "tokensRecovered"
> & {
  totalCompactions: number | null;
  tokensRecovered: number | null;
};

/**
 * A payload whose counts did not survive the wire. The single narrowing cast is
 * the point: the fields are non-nullable in TypeScript and nullable in a real
 * response, and this is the only way to drive the boundary the component guards.
 */
function withAbsent(
  over: Partial<WireCompactionImpact>
): WorkflowCompactionImpactData {
  const wire: WireCompactionImpact = { ...data, ...over };
  return wire as WorkflowCompactionImpactData;
}
