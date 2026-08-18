import { describe, expect, it } from "vitest";
import { AgentComponentKind, PLUGIN_CHILD_KINDS } from "../agent-component";

/**
 * ISS-6094 — `PLUGIN_CHILD_KINDS` is read by four surfaces that must agree: the
 * cloud rollup join, the cloud detail read, the three desktop rollup queries,
 * and the desktop backfill that stamps `agent_components.pack_id`. The desktop
 * pair reach it through a desktop-owned SQL renderer, covered in
 * `apps/desktop/test/plugin-child-kinds-sql.test.ts`; only the kind list itself
 * is this package's to own.
 *
 * The desktop parity test (`apps/desktop/test/plugin-child-kind-parity.test.ts`)
 * proves the BACKFILL and this constant agree, but it derives both its fixture
 * and its expectation from this constant — so narrowing the constant itself
 * would narrow both together and stay green while every consumer silently
 * agreed to under-count. That is exactly how the original defect shipped: the
 * backfill covered two kinds, every reader four, and nothing was red.
 *
 * The membership expectation is therefore ENUMERATED here rather than derived
 * from the constant — it is a change detector at the single source of truth, not
 * a second declaration. It spells the members as `AgentComponentKind` references
 * (never raw strings), so it pins exactly what a fixture may not re-declare —
 * the SET and the ORDER — while the kind values themselves still have one home.
 */
describe("PLUGIN_CHILD_KINDS", () => {
  it("carries exactly the four invocation-carrying child kinds", () => {
    // Enumerated on purpose — see the file docstring. If this fails because a
    // kind was ADDED, confirm every consumer named in the constant's docstring
    // reads it (they all import it, so they will) and update this list. If it
    // fails because a kind was REMOVED, that removal makes every plugin whose
    // children are that kind roll up to zero — establish that is intended first.
    expect([...PLUGIN_CHILD_KINDS]).toEqual([
      AgentComponentKind.Skill,
      AgentComponentKind.Command,
      AgentComponentKind.Subagent,
      AgentComponentKind.Mcp,
    ]);
  });

  it("holds only real AgentComponentKind members", () => {
    const known = new Set<string>(Object.values(AgentComponentKind));
    for (const kind of PLUGIN_CHILD_KINDS) {
      expect(known.has(kind)).toBe(true);
    }
  });

  it("never includes the plugin kind itself", () => {
    // A plugin has no usage rows of its own; including it would make a plugin
    // roll its own (always-zero) usage into its total and, worse, let the
    // desktop backfill overwrite a plugin row's own pack_id.
    expect([...PLUGIN_CHILD_KINDS]).not.toContain(AgentComponentKind.Plugin);
  });
});
