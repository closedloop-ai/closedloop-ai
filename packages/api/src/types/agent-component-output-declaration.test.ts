/**
 * @file agent-component-output-declaration.test.ts
 * @description Pins ISS-10728's declaration against NON-CIRCULAR LITERALS.
 *
 * DELIBERATE DEVIATION from AGENTS.md → Code Style ("import the contract
 * constant, do not repeat the string"), and the reason is the whole point of
 * this file. A fixture built from the very const it polices agrees with that
 * const's mistakes: deleting a kind, adding a kind, or flipping one kind's
 * declared family all stay green when the expectation is spelled
 * `AgentComponentOutputFamily.None`. The duplication IS the test — it is the
 * only mechanism that can observe the table changing. The contract's own
 * constants are exercised through the production entry points below
 * (`resolveAgentComponentOutputValue` and the compile-time exhaustiveness
 * guard), so this file is the trip-wire on top of that coverage rather than the
 * only coverage, which is the sanctioned shape in AGENTS.md → Test Practices.
 */

import { describe, expect, it } from "vitest";
import {
  AgentComponentKind,
  isLocPerDollarVerifiableKind,
} from "./agent-component.ts";
import type { AgentComponentInvocationKind } from "./agent-component-invocation.ts";
import {
  AGENT_COMPONENT_KIND_OUTPUT_RULE,
  type AgentComponentKindOutputRule,
  resolveAgentComponentOutputDeclaration,
  resolveAgentComponentOutputValue,
  SUBAGENT_COMPONENT_OUTPUT_DECLARATION,
} from "./agent-component-output-declaration.ts";

const EVERY_INVOCATION_KIND = [
  "command",
  "hook",
  "mcp",
  "orchestration",
  "skill",
  "subagent",
  "tool",
];

/**
 * Every kind's declared output, spelled out. A kind resolving per component
 * key is written `by_component_key` because it has no family of its own.
 */
const DECLARED_OUTPUT_BY_KIND: readonly (readonly [
  AgentComponentInvocationKind,
  string,
])[] = [
  ["tool", "none"],
  ["mcp", "none"],
  ["hook", "none"],
  ["orchestration", "none"],
  ["command", "none"],
  ["skill", "unclassified"],
  ["subagent", "by_component_key"],
];

function declaredOutputOf(rule: AgentComponentKindOutputRule): string {
  return rule.resolution === "by_kind" ? rule.declaration : "by_component_key";
}

describe("the kind table is exhaustive by construction", () => {
  it("declares exactly the seven invocation kinds and no others", () => {
    expect(Object.keys(AGENT_COMPONENT_KIND_OUTPUT_RULE).sort()).toEqual(
      [...EVERY_INVOCATION_KIND].sort()
    );
  });

  it.each(DECLARED_OUTPUT_BY_KIND)(
    "declares %s as %s",
    (kind, expectedDeclaration) => {
      expect(declaredOutputOf(AGENT_COMPONENT_KIND_OUTPUT_RULE[kind])).toBe(
        expectedDeclaration
      );
    }
  );

  it("adding a kind to the union fails tsc until it is classified", () => {
    type SyntheticallyWidenedKind =
      | AgentComponentInvocationKind
      | "synthetic_new_kind";

    // The proof itself: the table cannot satisfy a union carrying one more
    // member. If someone loosens the Record to an index signature, this
    // `@ts-expect-error` becomes unused and `pnpm typecheck` goes red — so the
    // guarantee cannot be removed silently in either direction.
    // @ts-expect-error — `synthetic_new_kind` is unclassified, which is the point.
    const widened: Record<
      SyntheticallyWidenedKind,
      AgentComponentKindOutputRule
    > = AGENT_COMPONENT_KIND_OUTPUT_RULE;

    expect(Object.keys(widened)).not.toContain("synthetic_new_kind");
  });
});

describe("kinds that enable rather than produce declare none", () => {
  it.each(["Read", "Glob", "Grep"])(
    "classifies the %s tool as none, not as a zero",
    (componentKey) => {
      expect(
        resolveAgentComponentOutputDeclaration({
          componentKind: "tool",
          componentKey,
        })
      ).toBe("none");
    }
  );
});

describe("subagents resolve by componentKey, not by kind", () => {
  it("gives two subagents in the same fixture different declarations", () => {
    const critic = resolveAgentComponentOutputDeclaration({
      componentKind: "subagent",
      componentKey: "review-soul",
    });
    const builder = resolveAgentComponentOutputDeclaration({
      componentKind: "subagent",
      componentKey: "design-engineer",
    });

    expect(critic).toBe("critique");
    expect(builder).toBe("production");
    expect(critic).not.toBe(builder);
  });

  it("classifies an explorer as none — a ruling, not an absence", () => {
    expect(
      resolveAgentComponentOutputDeclaration({
        componentKind: "subagent",
        componentKey: "code:pre-explorer",
      })
    ).toBe("none");
  });

  it("leaves an unclassified key distinguishable from a classified none", () => {
    const unclassified = resolveAgentComponentOutputDeclaration({
      componentKind: "subagent",
      componentKey: "nobody-has-classified-this-agent",
    });

    expect(unclassified).toBe("unclassified");
    expect(unclassified).not.toBe("none");
  });

  it("does not let a prototype key masquerade as a declaration", () => {
    expect(
      resolveAgentComponentOutputDeclaration({
        componentKind: "subagent",
        componentKey: "__proto__",
      })
    ).toBe("unclassified");
  });
});

describe("a kind this build does not know degrades, it does not throw", () => {
  // `component_kind` is a bare String column, so a retired spelling or a kind a
  // newer desktop build emits reaches this contract at runtime whatever the
  // annotation says (AGENTS.md: types do not constrain persisted rows).
  it.each(["retired_kind_nobody_writes_anymore", "__proto__"])(
    "resolves the unrecognized kind %s as unclassified",
    (componentKind) => {
      expect(
        resolveAgentComponentOutputDeclaration({
          componentKind: componentKind as AgentComponentInvocationKind,
          componentKey: "anything",
        })
      ).toBe("unclassified");
    }
  );

  it("renders an unrecognized kind as unknown, never as a zero", () => {
    const value = resolveAgentComponentOutputValue({
      componentKind:
        "a_kind_from_a_newer_build" as AgentComponentInvocationKind,
      componentKey: "anything",
      measuredCount: 0,
    });

    expect(value).toEqual({ state: "unknown" });
  });
});

describe("no consumer can render a zero for a kind that declares none", () => {
  it.each([
    ["tool", "Read", "not_applicable"],
    ["hook", "PreToolUse", "not_applicable"],
    ["skill", "create-feat", "unknown"],
    ["subagent", "nobody-has-classified-this-agent", "unknown"],
  ])(
    "gives %s/%s the state %s and no number, even when the row carries 0",
    (componentKind, componentKey, expectedState) => {
      const value = resolveAgentComponentOutputValue({
        componentKind: componentKind as AgentComponentInvocationKind,
        componentKey,
        measuredCount: 0,
      });

      expect(value.state).toBe(expectedState);
      // The assertion that actually stops the defect: there is no numeric
      // field to render, so a surface cannot print `0` by reading one.
      expect(Object.hasOwn(value, "value")).toBe(false);
      expect(Object.hasOwn(value, "family")).toBe(false);
    }
  );

  it("keeps a measured zero measured where the kind declares a family", () => {
    const value = resolveAgentComponentOutputValue({
      componentKind: "subagent",
      componentKey: "review-soul",
      measuredCount: 0,
    });

    expect(value).toEqual({
      state: "measured",
      family: "critique",
      value: 0,
    });
  });

  it.each([null, undefined])(
    "reports a declared family with no row value as not_measured (%s)",
    (measuredCount) => {
      const value = resolveAgentComponentOutputValue({
        componentKind: "subagent",
        componentKey: "design-engineer",
        measuredCount,
      });

      expect(value).toEqual({
        state: "not_measured",
        family: "production",
        absence: "not_reported",
      });
      expect(Object.hasOwn(value, "value")).toBe(false);
    }
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "refuses to publish the impossible count %s as measured",
    (measuredCount) => {
      const value = resolveAgentComponentOutputValue({
        componentKind: "subagent",
        componentKey: "design-engineer",
        measuredCount,
      });

      // Labelled `unusable`, NOT folded into the ordinary `not_reported` gap:
      // a corrupt row and a missing one are different upstream facts.
      expect(value).toEqual({
        state: "not_measured",
        family: "production",
        absence: "unusable",
      });
    }
  );
});

describe("the declaration does not contradict the existing LOC/$ ruling", () => {
  /**
   * FEA-4052's `LOC_PER_DOLLAR_VERIFIABILITY` is the repo's other exhaustive
   * per-kind numerator ruling, and the module above claims to adopt rather than
   * reopen it. That claim was prose only. This makes it falsifiable: a kind
   * whose LOC/$ is verifiable HAS a production numerator, so declaring it no
   * output would have two tables answering the same question differently.
   * `agent-component.ts:1196` names the trigger — "re-add them here once
   * session partitioning exists" — so this reddens when that day comes.
   *
   * THE CHECK IS MADE AT THE GRAIN THE KIND RESOLVES AT. `subagent` is both the
   * only LOC/$-verifiable kind today and the only kind that resolves per
   * `componentKey`, so asking the KIND what it declares returns
   * `by_component_key` and answers nothing — the shape this sweep used to have,
   * which made its one live case vacuous. The contradiction for such a kind
   * lives in the per-key table, so that is where it is asserted.
   */
  const LOC_PER_DOLLAR_VERIFIABLE_KINDS_TODAY = Object.values(
    AgentComponentKind
  ).filter(isLocPerDollarVerifiableKind);

  it("still admits at least one LOC/$-verifiable kind, so the sweep is not vacuous", () => {
    expect(LOC_PER_DOLLAR_VERIFIABLE_KINDS_TODAY).not.toHaveLength(0);
  });

  it.each(LOC_PER_DOLLAR_VERIFIABLE_KINDS_TODAY)(
    "never declares the LOC/$-verifiable kind %s to have no output",
    (kind) => {
      if (!Object.hasOwn(AGENT_COMPONENT_KIND_OUTPUT_RULE, kind)) {
        // An INVENTORY-only kind: it never runs, so it has no invocation-grain
        // declaration that could contradict. Pinned rather than silently
        // skipped, so this branch can only be taken by a kind that really is
        // outside the invocation union.
        expect(EVERY_INVOCATION_KIND).not.toContain(kind);
        return;
      }

      const rule =
        AGENT_COMPONENT_KIND_OUTPUT_RULE[kind as AgentComponentInvocationKind];
      if (rule.resolution === "by_kind") {
        expect(rule.declaration).not.toBe("none");
        return;
      }

      // Resolves per component key, so the kind itself declares nothing to
      // contradict. What WOULD contradict is a per-key table in which no key
      // can carry the production numerator LOC/$ verifiability promises.
      expect(
        Object.values(SUBAGENT_COMPONENT_OUTPUT_DECLARATION).filter(
          (family) => family === "production"
        )
      ).not.toHaveLength(0);
    }
  );
});

describe("the critique numerator reaches the key it is actually persisted as", () => {
  // `@repo/lib/code-review/findings-funnel-attribution` emits the WORKER key as
  // the matched subagent `componentKey` for every reviewer role, so declaring
  // only the role name would leave the confirmed-findings funnel unreachable.
  it.each([
    "code-review:code-review-worker",
    "code-review:code-review-worker-graph",
  ])("declares the persisted review worker %s as critique", (componentKey) => {
    expect(
      resolveAgentComponentOutputDeclaration({
        componentKind: "subagent",
        componentKey,
      })
    ).toBe("critique");
  });

  it("carries a confirmed-findings count through as a measured critique value", () => {
    expect(
      resolveAgentComponentOutputValue({
        componentKind: "subagent",
        componentKey: "code-review:code-review-worker",
        measuredCount: 3,
      })
    ).toEqual({ state: "measured", family: "critique", value: 3 });
  });
});

describe("a componentKey is folded before it is looked up", () => {
  it.each(["Review-Soul", "REVIEW-SOUL", "  review-soul  "])(
    "resolves the persisted spelling %s as critique, not unknown",
    (componentKey) => {
      expect(
        resolveAgentComponentOutputDeclaration({
          componentKind: "subagent",
          componentKey,
        })
      ).toBe("critique");
    }
  );
});

describe("both tables are built on a null prototype", () => {
  it.each([
    ["kind rule", AGENT_COMPONENT_KIND_OUTPUT_RULE],
    ["subagent declaration", SUBAGENT_COMPONENT_OUTPUT_DECLARATION],
  ])(
    "gives the %s table no inherited members a direct index read could hit",
    (_label, table) => {
      expect(Object.getPrototypeOf(table)).toBeNull();
      // The defect the null prototype prevents: a bare index read on a plain
      // object returns `Object.prototype.constructor` here, not `undefined`.
      expect((table as Record<string, unknown>).constructor).toBeUndefined();
    }
  );
});
