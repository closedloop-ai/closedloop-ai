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
import { KIND_META, KindBadge, kindMeta } from "../component-meta";

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
