/**
 * ISS-10728 — what each agent-component kind's useful OUTPUT is, declared.
 *
 * ISS-6360's central claim is that a component kind declares what its useful
 * output IS, so that output can be divided by what it cost. That declaration
 * had no home: no type, no table, no constant. Every downstream surface was
 * therefore left to guess, and the guess always came out the same way — a kind
 * with no numerator renders `0`, which reads as "produced nothing" when it
 * means "we do not measure output for this kind". This module is the
 * declaration, so nobody has to guess.
 *
 * WHICH OF THE TWO KIND UNIONS THIS KEYS ON, AND WHY.
 * There are two, and they are not the same set: {@link AgentComponentKind} has
 * ten members (it adds `workflow`, `config` and `plugin`) and describes an
 * INVENTORY row — a component that exists. {@link AgentComponentInvocationKind}
 * has seven and describes an invocation — a component that RAN. This module
 * keys on the INVOCATION union, because that is the grain output is measured
 * at: an output number is produced by a run, and the cost it divides
 * (`agent_component_invocations`) sits at that same grain. Keying the inventory
 * union instead would put a declaration on `config` and `plugin`, which never
 * run and so can never carry a numerator of their own.
 *
 * THE DECLARATION IS PER KIND; THE MEASUREMENT IS PER INVOCATION.
 * A kind declaring `critique` does not promise that every invocation of it
 * carries a count. It promises the question is MEANINGFUL for that kind. The
 * read contract has to tell three things apart — a measured zero, an unmeasured
 * run, and a kind the question does not apply to. The first two come from the
 * row; only this declaration can supply the third, and a fourth state (nobody
 * has ruled yet) is supplied by its absence. See
 * {@link resolveAgentComponentOutputValue}.
 *
 * WHERE THE NUMBER COMES FROM, AND WHY THIS IS NOT A SECOND READ CONTRACT.
 * This module answers "is the question meaningful for this component", at the
 * KIND/component grain. `agent-component-findings-funnel.ts` answers "what did
 * THIS invocation's ingest actually record", at the invocation grain. They
 * compose in one direction only: a funnel reading's `findingsConfirmed` is the
 * `measuredCount` a `critique`-family subject is resolved with, and the funnel's
 * own `unknown` becomes this contract's `not_measured`/`not_reported`. A
 * consumer therefore calls THIS function and passes the funnel in — it does not
 * call two contracts and reconcile them. The third state the funnel's header
 * says ISS-10728 owes it ("a kind that declares it has no findings output at
 * all") is {@link AgentComponentOutputReadState.NotApplicable} here, which is
 * why the funnel is still right not to invent it.
 *
 * Follows the {@link AgentComponentInvocationUsageMeasurement} precedent: a
 * value travels with a label saying how it was arrived at, and an absent label
 * is never folded into a zero.
 *
 * BUNDLE NOTE: this module reaches Zod transitively, through the runtime
 * `AgentComponentInvocationKind` const in `agent-component-invocation.ts`
 * (which imports `./session-artifact-link.ts`, which imports `zod`). Importing
 * the canonical const is correct — re-declaring the seven strings here to buy a
 * lighter graph would be SSOT drift by copy. A bundle-sensitive `"use client"`
 * consumer needs that kind const hoisted into a leaf module first; that is a
 * change to a file ISS-10718 currently holds, so it is not made here.
 */

import { normalizeComponentKey } from "./agent-component-analytics.ts";
import { AgentComponentInvocationKind } from "./agent-component-invocation.ts";

/**
 * The three output families a component kind can declare. PRD-753 ratifies
 * exactly two numerators plus the honest third answer:
 *
 * - `Production` — lines of code, spec lines, document lines. Over dollars this
 *   is LOC/$ and its siblings, still subject to `LOC_PER_DOLLAR_VERIFIABLE_KINDS`
 *   (FEA-4052), which this module adopts rather than reopens.
 * - `Critique` — findings that survived validation. A reviewer emits N and M are
 *   invalidated; the survivors are its output.
 * - `None` — the component declares no useful output of its own. A RULING, not
 *   a gap: `Read` ENABLES rather than PRODUCES, and forcing a ratio onto it
 *   invents a number. `Glob`, `Grep` and most `mcp` reads are the same shape; a
 *   hook that fires and returns gates rather than produces; an `orchestration`
 *   is a container whose children carry the output. Each still reports its
 *   footprint, which is the one denominator every kind holds.
 *
 * The two numerators DO NOT COMBINE (PRD-753 R4). Lines and findings are
 * different outputs in different units; a blended score would invent a unit
 * nobody can defend.
 */
export const AgentComponentOutputFamily = {
  Production: "production",
  Critique: "critique",
  None: "none",
} as const;
export type AgentComponentOutputFamily =
  (typeof AgentComponentOutputFamily)[keyof typeof AgentComponentOutputFamily];

/** The families that can actually carry a number. `None` never can. */
export type AgentComponentMeasurableOutputFamily =
  | typeof AgentComponentOutputFamily.Production
  | typeof AgentComponentOutputFamily.Critique;

/**
 * A resolved declaration: one of the three families, or `Unclassified`.
 *
 * `None` and `Unclassified` are DIFFERENT FACTS and must never render
 * identically. `None` is a ruling — this component will never have a numerator.
 * `Unclassified` is an unanswered question — nobody has decided yet. Both
 * render as something other than a number; only one of them is settled.
 */
export const AgentComponentOutputDeclaration = {
  Production: AgentComponentOutputFamily.Production,
  Critique: AgentComponentOutputFamily.Critique,
  None: AgentComponentOutputFamily.None,
  /** Nobody has declared for this component yet. Never a zero. */
  Unclassified: "unclassified",
} as const;
export type AgentComponentOutputDeclaration =
  (typeof AgentComponentOutputDeclaration)[keyof typeof AgentComponentOutputDeclaration];

/** How a kind's declaration is arrived at. */
export const AgentComponentOutputResolution = {
  /** The kind's own declaration applies to every invocation of it. */
  ByKind: "by_kind",
  /** The declaration is per component; look the `componentKey` up. */
  ByComponentKey: "by_component_key",
} as const;
export type AgentComponentOutputResolution =
  (typeof AgentComponentOutputResolution)[keyof typeof AgentComponentOutputResolution];

/**
 * A kind either declares its own family or defers to per-component
 * declarations. Written as a discriminated union so a kind that defers cannot
 * also carry a family, and a kind that declares cannot omit one.
 */
export type AgentComponentKindOutputRule =
  | {
      readonly resolution: typeof AgentComponentOutputResolution.ByKind;
      readonly declaration: AgentComponentOutputDeclaration;
    }
  | {
      readonly resolution: typeof AgentComponentOutputResolution.ByComponentKey;
    };

/**
 * EXHAUSTIVE BY CONSTRUCTION over {@link AgentComponentInvocationKind}.
 *
 * Deliberately NOT a `ReadonlySet<Kind>` or a `string[]` policy list. AGENTS.md
 * → Review Lessons states the trap verbatim: a side inventory built from
 * today's members still compiles when a new member is added, falls to the
 * default branch, and silently changes the answer — which is the very
 * "renders 0" defect this module exists to kill. Typing the element is the
 * floor, not the fix. A `Record<AgentComponentInvocationKind, …>` cannot be
 * written without naming every member, so a new kind fails `tsc` here until
 * somebody decides what it produces.
 */
const AGENT_COMPONENT_KIND_OUTPUT_RULE_ENTRIES: Record<
  AgentComponentInvocationKind,
  AgentComponentKindOutputRule
> = {
  // Enables rather than produces — the reason recorded once, on the family's
  // own docstring above, and shared by the four kinds below it.
  [AgentComponentInvocationKind.Tool]: {
    resolution: AgentComponentOutputResolution.ByKind,
    declaration: AgentComponentOutputDeclaration.None,
  },
  [AgentComponentInvocationKind.Mcp]: {
    resolution: AgentComponentOutputResolution.ByKind,
    declaration: AgentComponentOutputDeclaration.None,
  },
  [AgentComponentInvocationKind.Hook]: {
    resolution: AgentComponentOutputResolution.ByKind,
    declaration: AgentComponentOutputDeclaration.None,
  },
  [AgentComponentInvocationKind.Orchestration]: {
    resolution: AgentComponentOutputResolution.ByKind,
    declaration: AgentComponentOutputDeclaration.None,
  },
  // A command is an expansion that delegates; its footprint is real and its
  // output belongs to whatever it dispatched (PRD-753).
  [AgentComponentInvocationKind.Command]: {
    resolution: AgentComponentOutputResolution.ByKind,
    declaration: AgentComponentOutputDeclaration.None,
  },
  // UNRULED ON PURPOSE — PRD-753 Open Question 2, recorded 2026-09-19 and still
  // open. PRD-753 holds that a skill declares PER COMPONENT (a `logical-qa`
  // skill produces critique, a `create-feat` skill produces spec lines);
  // ISS-10728 holds that `subagent` is the only kind carved out for
  // per-`componentKey` resolution. No operator ruling exists, and the PRD says
  // in terms that it must not be resolved by implementation. `Unclassified`
  // encodes exactly that state — an unanswered question, rendered as unknown —
  // without taking either position. Whoever rules replaces this entry.
  [AgentComponentInvocationKind.Skill]: {
    resolution: AgentComponentOutputResolution.ByKind,
    declaration: AgentComponentOutputDeclaration.Unclassified,
  },
  // The one kind where the family genuinely is not a property of the kind: a
  // `review-soul` subagent produces critique, a `design-engineer` subagent
  // produces code, a `code:pre-explorer` subagent produces neither.
  [AgentComponentInvocationKind.Subagent]: {
    resolution: AgentComponentOutputResolution.ByComponentKey,
  },
};

/**
 * The exported table, on a NULL PROTOTYPE (AGENTS.md → Code Style: dispatch
 * tables and handler registries are built with `Object.create(null)`). Both
 * lookups here are keyed by a runtime-persisted string, so a plain `{}` lets a
 * direct index read — this module's own or a future consumer's — resolve
 * `constructor` or `__proto__` to an inherited object instead of `undefined`.
 * `Object.hasOwn` protects the resolver below; the null prototype protects
 * everyone who does not use it.
 *
 * The exhaustiveness guard lives on the annotated literal above rather than
 * here, and must: `Object.assign` widens its result to `any`, so an object
 * literal written directly into this position would NOT be checked against the
 * `Record` and a missing kind would compile.
 */
export const AGENT_COMPONENT_KIND_OUTPUT_RULE: Record<
  AgentComponentInvocationKind,
  AgentComponentKindOutputRule
> = Object.assign(
  Object.create(null),
  AGENT_COMPONENT_KIND_OUTPUT_RULE_ENTRIES
);

/**
 * Per-`componentKey` declarations for `subagent`, the one kind whose family is
 * not a property of the kind.
 *
 * Seeded with the three keys ISS-10728 itself rules on, plus the two keys the
 * code-review fleet is ACTUALLY PERSISTED AS. A key absent from this table is
 * UNCLASSIFIED, not `None`: it says we have not decided, which is true, and it
 * renders as unknown rather than as a zero. Classifying the rest of the fleet
 * is a product decision this module does not take.
 *
 * KEYS ARE WRITTEN IN NORMALIZED FORM — lowercase, untrimmed-of-nothing —
 * because the lookup folds its subject through {@link normalizeComponentKey},
 * the same codec the org-identity slug uses. A key spelled with different case
 * here would be unreachable.
 *
 * Typed to {@link AgentComponentOutputFamily} rather than to the declaration
 * union, so `Unclassified` cannot be written here — absence is the only way to
 * say it, and there is therefore exactly one representation of "unruled".
 */
const SUBAGENT_COMPONENT_OUTPUT_DECLARATION_ENTRIES: Readonly<
  Record<string, AgentComponentOutputFamily>
> = {
  "review-soul": AgentComponentOutputFamily.Critique,
  "design-engineer": AgentComponentOutputFamily.Production,
  // Explores; produces neither lines nor findings (ISS-10728).
  "code:pre-explorer": AgentComponentOutputFamily.None,
  // THE KEYS THE CRITIQUE NUMERATOR ACTUALLY ARRIVES UNDER. A `review-soul`
  // domain critic is not persisted as `review-soul`: the code-review plugin
  // spawns every reviewer role — the auditor, both bug hunters and every
  // `domain_N` critic alike — as one of these two worker subagents, and
  // `@repo/lib/code-review/findings-funnel-attribution` emits THAT key as the
  // matched `componentKey`. Declaring only the role name would leave the
  // critique family unreachable for the invocations that carry the funnel,
  // which is the one numerator this module exists to enable. Both keys are
  // carried because the graph-aware worker was split out later and older runs
  // record graph roles under the default one.
  "code-review:code-review-worker": AgentComponentOutputFamily.Critique,
  "code-review:code-review-worker-graph": AgentComponentOutputFamily.Critique,
};

/**
 * The exported per-key table, on a NULL PROTOTYPE for the same reason as
 * {@link AGENT_COMPONENT_KIND_OUTPUT_RULE}: `componentKey` is a runtime
 * persisted string and a plain `{}` would resolve `constructor` to an
 * inherited function for any consumer that indexes it directly.
 */
export const SUBAGENT_COMPONENT_OUTPUT_DECLARATION: Readonly<
  Record<string, AgentComponentOutputFamily>
> = Object.assign(
  Object.create(null),
  SUBAGENT_COMPONENT_OUTPUT_DECLARATION_ENTRIES
);

/**
 * WHY a declared family carries no usable number. Absent and impossible are
 * different upstream facts and must not collapse into one another: a row with
 * no count is ordinary telemetry gap, a row carrying `-1` or `1.5` is a corrupt
 * source or a producer bug that somebody has to see (AGENTS.md → Handling Bad
 * or Nonsensical Data). Neither ever becomes a rendered number.
 */
export const AgentComponentOutputAbsence = {
  /** The invocation row carries no count at all. */
  NotReported: "not_reported",
  /**
   * The row carries a figure no real measurement could take. Surfaced on the
   * value rather than coerced away, so a server-side consumer can route it to
   * the monitor that owns its ingest path.
   */
  Unusable: "unusable",
} as const;
export type AgentComponentOutputAbsence =
  (typeof AgentComponentOutputAbsence)[keyof typeof AgentComponentOutputAbsence];

/**
 * What state a declared output is in for one invocation.
 *
 * Four states, four renderings (PRD-753 R1). `Measured` is the only one that
 * carries a number, so a consumer cannot reach a `0` for a kind that declares
 * none — see {@link AgentComponentOutputValue}.
 */
export const AgentComponentOutputReadState = {
  /** The kind declares a family and this invocation carries a usable count. */
  Measured: "measured",
  /** The kind declares a family; this invocation carries no usable count. */
  NotMeasured: "not_measured",
  /** The kind rules that it has no numerator. Never a zero. */
  NotApplicable: "not_applicable",
  /** Nobody has declared for this component yet. Never a zero. */
  Unknown: "unknown",
} as const;
export type AgentComponentOutputReadState =
  (typeof AgentComponentOutputReadState)[keyof typeof AgentComponentOutputReadState];

/**
 * The read contract a surface renders from.
 *
 * `value` exists on the `Measured` arm ALONE. That is the type-level half of
 * ISS-10728's last acceptance criterion: a consumer cannot render `0` for a
 * kind whose declaration is `none` or unclassified, because on those arms there
 * is no number to reach for. The runtime half is pinned by the sibling test.
 */
export type AgentComponentOutputValue =
  | {
      readonly state: typeof AgentComponentOutputReadState.Measured;
      readonly family: AgentComponentMeasurableOutputFamily;
      readonly value: number;
    }
  | {
      readonly state: typeof AgentComponentOutputReadState.NotMeasured;
      readonly family: AgentComponentMeasurableOutputFamily;
      readonly absence: AgentComponentOutputAbsence;
    }
  | { readonly state: typeof AgentComponentOutputReadState.NotApplicable }
  | { readonly state: typeof AgentComponentOutputReadState.Unknown };

/** One invocation's identity, as far as the declaration is concerned. */
export type AgentComponentOutputSubject = {
  readonly componentKind: AgentComponentInvocationKind;
  readonly componentKey: string;
};

/**
 * The declaration for one invocation: the kind's own, or — for `subagent` — the
 * one registered against its `componentKey`, defaulting to `Unclassified`.
 *
 * `componentKey` IS FOLDED THROUGH {@link normalizeComponentKey}, the canonical
 * lowercase/trim codec `agent-component-analytics.ts` already owns and the
 * org-identity slug already applies. A persisted row spelled `Review-Soul`, or
 * carrying the whitespace a producer left on it, is the SAME component as
 * `review-soul`, and without the fold it resolves `unclassified` and renders
 * unknown instead of critique. Re-spelling the fold here would be SSOT drift by
 * copy, so the canonical one is imported.
 *
 * `Object.hasOwn` on BOTH lookups rather than a bare index read. `componentKey`
 * is an untrusted `"__proto__"` away from returning an inherited object instead
 * of `undefined` (AGENTS.md → Code Style, dispatch tables) — belt and braces
 * beside the null prototype both tables are built on, because a null prototype
 * stops inheritance and `Object.hasOwn` is what keeps an OWN key that happens
 * to be named `__proto__` from being read as a declaration. And `componentKind`
 * is not constrained by its annotation at runtime: `component_kind` is a bare
 * `String` column, so a retired spelling or a kind a newer desktop build emits
 * reaches this function and must degrade to `Unclassified` — the state that
 * already means "nobody has declared this" — rather than throw on an undefined
 * rule (AGENTS.md → Cross-Repo Compatibility Requirements).
 *
 * Both guards are RUNTIME invariants, not compiler-enforced ones: this package
 * does not set `noUncheckedIndexedAccess`, so an indexed read types as present
 * whether or not the check precedes it. A second call site that skips them
 * compiles just the same, which is why the sibling test pins both at runtime.
 */
export function resolveAgentComponentOutputDeclaration(
  subject: AgentComponentOutputSubject
): AgentComponentOutputDeclaration {
  if (!Object.hasOwn(AGENT_COMPONENT_KIND_OUTPUT_RULE, subject.componentKind)) {
    return AgentComponentOutputDeclaration.Unclassified;
  }
  const rule = AGENT_COMPONENT_KIND_OUTPUT_RULE[subject.componentKind];
  if (rule.resolution === AgentComponentOutputResolution.ByKind) {
    return rule.declaration;
  }
  const normalizedKey = normalizeComponentKey(subject.componentKey);
  return Object.hasOwn(SUBAGENT_COMPONENT_OUTPUT_DECLARATION, normalizedKey)
    ? SUBAGENT_COMPONENT_OUTPUT_DECLARATION[normalizedKey]
    : AgentComponentOutputDeclaration.Unclassified;
}

/**
 * True when `count` is a value a measured output could actually take.
 *
 * Output counts are whole non-negative quantities, so a negative, fractional,
 * non-finite, or out-of-safe-range figure cannot be a real measurement. Such a
 * value resolves to `NotMeasured` carrying
 * {@link AgentComponentOutputAbsence.Unusable}, rather than being published,
 * because a confident wrong number is worse than an honest absence (AGENTS.md →
 * Handling Bad or Nonsensical Data). It is labelled instead of coerced away so
 * a server-side consumer can tell a corrupt row from a missing one and route it
 * to the monitor that owns its ingest path.
 */
function isUsableOutputCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0;
}

/**
 * Resolve one invocation's output into the four-state read contract.
 *
 * `measuredCount` is whatever the row carries — merged lines for `production`,
 * surviving findings for `critique`. A `0` is preserved as a MEASURED zero when
 * the kind declares a family, and is unreachable when it does not.
 */
export function resolveAgentComponentOutputValue(
  subject: AgentComponentOutputSubject & {
    readonly measuredCount: number | null | undefined;
  }
): AgentComponentOutputValue {
  const declaration = resolveAgentComponentOutputDeclaration(subject);
  if (declaration === AgentComponentOutputDeclaration.Unclassified) {
    return { state: AgentComponentOutputReadState.Unknown };
  }
  if (declaration === AgentComponentOutputDeclaration.None) {
    return { state: AgentComponentOutputReadState.NotApplicable };
  }
  const family = declaration;
  if (subject.measuredCount === null || subject.measuredCount === undefined) {
    return {
      state: AgentComponentOutputReadState.NotMeasured,
      family,
      absence: AgentComponentOutputAbsence.NotReported,
    };
  }
  if (!isUsableOutputCount(subject.measuredCount)) {
    return {
      state: AgentComponentOutputReadState.NotMeasured,
      family,
      absence: AgentComponentOutputAbsence.Unusable,
    };
  }
  return {
    state: AgentComponentOutputReadState.Measured,
    family,
    value: subject.measuredCount,
  };
}
