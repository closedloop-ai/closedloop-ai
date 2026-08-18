/**
 * Regression: an unmapped component `kind` must never crash the Agents page.
 *
 * The desktop collectors can emit a kind not in the AgentComponentKind enum,
 * and the cloud syncs it. The web workspace renders `<KindBadge kind={row.kind}>`
 * for every row (agents-table.tsx). Before the kindMeta() fallback, KindBadge
 * dereferenced `KIND_META[kind].variant` — undefined — which threw and took the
 * ENTIRE Agents page down (real prod crash: 88 synced `tool` rows). kindMeta()
 * resolves a labelized fallback instead.
 *
 * FEA-3048: `tool` is now a FIRST-CLASS mapped kind (its own "Tool" badge), so
 * it renders through KIND_META, not the fallback. A genuinely-unmapped kind
 * still exercises the fallback below.
 */
import {
  AgentComponentKind,
  type AgentComponentKind as AgentComponentKindType,
} from "@repo/api/src/types/agent-component";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  hasVersionHistoryAffordance,
  KIND_META,
  KindBadge,
  KindLabel,
  kindMeta,
} from "../component-meta";

// A value not present in the AgentComponentKind enum / KIND_META, to exercise
// the labelized fallback path (NOT "tool", which is now a mapped first-class
// kind).
const UNMAPPED_KIND = "some-future-kind" as AgentComponentKindType;

describe("kindMeta", () => {
  it("returns the declared metadata for a known kind", () => {
    expect(kindMeta(AgentComponentKind.Skill)).toBe(
      KIND_META[AgentComponentKind.Skill]
    );
  });

  it("returns the declared 'Tool' metadata for the first-class tool kind (FEA-3048)", () => {
    const meta = kindMeta(AgentComponentKind.Tool);
    expect(meta).toBe(KIND_META[AgentComponentKind.Tool]);
    expect(meta.label).toBe("Tool");
    expect(meta.plural).toBe("Tools");
    // Its own badge variant — NOT the 'outline'/'muted' Memory & config style
    // it was formerly coerced into.
    expect(meta.label).not.toBe("Memory & config");
  });

  it("returns a labelized fallback (never undefined) for an unmapped kind", () => {
    const meta = kindMeta(UNMAPPED_KIND);
    expect(meta.label).toBe("Some Future Kind");
    expect(meta.plural).toBe("Some Future Kinds");
    expect(meta.variant).toBe("outline");
    expect(meta.icon).toBeDefined();
  });

  it("title-cases multi-token unknown kinds", () => {
    expect(
      kindMeta("another-future-kind" as AgentComponentKindType).label
    ).toBe("Another Future Kind");
  });
});

describe("KindBadge", () => {
  it("renders the label for a known kind", () => {
    render(<KindBadge kind={AgentComponentKind.Command} />);
    expect(screen.getByText("Command")).toBeInTheDocument();
  });

  it("renders the 'Tool' label for the first-class tool kind (FEA-3048)", () => {
    render(<KindBadge kind={AgentComponentKind.Tool} />);
    expect(screen.getByText("Tool")).toBeInTheDocument();
  });

  it("renders (does not crash) for an unmapped kind — the prod Agents-page crash", () => {
    expect(() => render(<KindBadge kind={UNMAPPED_KIND} />)).not.toThrow();
    expect(screen.getByText("Some Future Kind")).toBeInTheDocument();
  });
});

describe("KindLabel", () => {
  it("renders the canonical per-kind icon from KIND_META", () => {
    for (const kind of Object.values(AgentComponentKind)) {
      const ExpectedIcon = KIND_META[kind].icon;
      const rendered = render(<KindLabel kind={kind} />);
      const expected = render(<ExpectedIcon />);

      expect(rendered.container.querySelector("svg")?.innerHTML).toBe(
        expected.container.querySelector("svg")?.innerHTML
      );
    }
  });

  it.each([
    [AgentComponentKind.Skill, "Skill"],
    [AgentComponentKind.Command, "Command"],
  ])("renders %s with the uniform icon and muted-label treatment", (kind, label) => {
    const { container } = render(<KindLabel kind={kind} />);
    const text = screen.getByText(label);
    const wrapper = text.parentElement;
    const icon = wrapper?.querySelector("svg");

    expect(wrapper).toHaveClass(
      "flex",
      "min-w-0",
      "items-center",
      "gap-1.5",
      "font-medium",
      "text-muted-foreground",
      "text-xs"
    );
    expect(text).toHaveClass("truncate");
    expect(icon).toHaveClass("size-3.5", "shrink-0");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("uses the canonical fallback icon and label for an unmapped kind", () => {
    const { container } = render(<KindLabel kind={UNMAPPED_KIND} />);
    const FallbackIcon = kindMeta(UNMAPPED_KIND).icon;
    const expected = render(<FallbackIcon />);

    expect(screen.getByText("Some Future Kind")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveClass("size-3.5", "shrink-0");
    expect(container.querySelector("svg")?.innerHTML).toBe(
      expected.container.querySelector("svg")?.innerHTML
    );
  });
});

describe("hasVersionHistoryAffordance (FEA-4267)", () => {
  it("is true only for the prompt kinds whose detail page shows a version dropdown", () => {
    // Subagent/command/skill render the Prompt panel (the only version selector),
    // so a catalog "N versions" count links to a real destination for them.
    expect(hasVersionHistoryAffordance(AgentComponentKind.Subagent)).toBe(true);
    expect(hasVersionHistoryAffordance(AgentComponentKind.Command)).toBe(true);
    expect(hasVersionHistoryAffordance(AgentComponentKind.Skill)).toBe(true);
  });

  it("is false for kinds whose detail page has no version selector", () => {
    // Mcp/plugin/workflow are observed but render NO Prompt panel; hook/config/
    // tool/orchestration have no version affordance either. A count for any of
    // them would send the user hunting for a dropdown that is not there.
    expect(hasVersionHistoryAffordance(AgentComponentKind.Mcp)).toBe(false);
    expect(hasVersionHistoryAffordance(AgentComponentKind.Plugin)).toBe(false);
    expect(hasVersionHistoryAffordance(AgentComponentKind.Workflow)).toBe(
      false
    );
    expect(hasVersionHistoryAffordance(AgentComponentKind.Hook)).toBe(false);
    expect(hasVersionHistoryAffordance(AgentComponentKind.Config)).toBe(false);
    expect(hasVersionHistoryAffordance(AgentComponentKind.Tool)).toBe(false);
    expect(hasVersionHistoryAffordance(AgentComponentKind.Orchestration)).toBe(
      false
    );
  });
});
