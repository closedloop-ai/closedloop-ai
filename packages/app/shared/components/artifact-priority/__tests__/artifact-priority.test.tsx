import { Priority } from "@repo/api/src/types/common";
import { ArtifactPriority } from "@repo/app/shared/components/artifact-priority/artifact-priority";
import {
  ARTIFACT_PRIORITY_VARIANT_SPEC,
  allowsArtifactPriorityUnset,
  showsArtifactPriorityLabel,
} from "@repo/app/shared/components/artifact-priority/artifact-priority-contract";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPriorityState,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { comparePriorityByRank } from "@repo/design-system/lib/priority-order";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  cleanup();
});

/**
 * Pinned as literals, independently of the design system's label map and of the
 * rank array, because a test that reads its expectation from the module it
 * polices stays green when a member is dropped from that module. The
 * duplication IS the assertion.
 */
const LABEL = {
  HIGH: "High",
  LOW: "Low",
  MEDIUM: "Medium",
  NONE: "No priority",
  UNKNOWN: "Unknown priority",
  URGENT: "Urgent",
} as const;

/**
 * Most urgent first, then unset. Written out, not derived from the rank map or
 * the order array this exists to police.
 *
 * The last entry is the design system's empty-value mark AND the word, with no
 * space between them because `textContent` concatenates the two spans. A
 * variant whose spec says it always paints a label paints one for the absent
 * value too (ISS-9441); the dense `Cell` shell still answers with the mark
 * alone, which is what the case below this one pins.
 */
const EXPECTED_RANK_ORDER = [
  LABEL.URGENT,
  LABEL.HIGH,
  LABEL.MEDIUM,
  LABEL.LOW,
  `—${LABEL.NONE}`,
];

/** A member only a newer peer knows. Reaches the mark as a wire string. */
const SKEWED_MEMBER = "BLOCKER";

/** Written out rather than read back from the component under test. */
const ERROR_LABEL = "Could not load";
const LOADING_LABEL = "Loading priority";
/** The design system's own markers for the two read states. */
const LOADING_MARK = '[data-cell-value-state="loading"]';
const ERROR_MARK = '[data-cell-value-state="error"]';
const CHAMPION = '[data-slot="artifact-priority"]';

/**
 * The two activity treatments ship behind the `batch-706-champion-ui` key, so a
 * case that wants to see one has to open it. Everything else in this file mounts
 * with no provider, which resolves closed and is the shipped default.
 */
function gated(children: ReactElement) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

function markText(element: ReactElement): string {
  const { container, unmount } = render(element);
  const mark = container.querySelector('[data-slot="artifact-priority"]');
  const text = mark?.textContent ?? "";
  unmount();
  return text;
}

/** The word a sighted reader sees, or `null` when the variant paints none. */
function visibleLabel(element: ReactElement): string | null {
  const { container, unmount } = render(element);
  const label = container.querySelector(
    '[data-slot="artifact-priority"] > span:not(.sr-only):not([data-priority-glyph])'
  );
  const text = label?.textContent ?? null;
  unmount();
  return text;
}

/** The word only assistive technology reads. */
function srOnlyLabel(element: ReactElement): string | null {
  const { container, unmount } = render(element);
  const text =
    container.querySelector('[data-slot="artifact-priority"] .sr-only')
      ?.textContent ?? null;
  unmount();
  return text;
}

function hasGlyph(element: ReactElement): boolean {
  const { container, unmount } = render(element);
  const glyph = container.querySelector("[data-priority-glyph]") !== null;
  unmount();
  return glyph;
}

describe("ArtifactPriority — one mark, nine variants", () => {
  it("renders every approved variant through the champion", () => {
    // Exhaustive by construction: a variant added to the approved vocabulary
    // fails typecheck in the spec map, and this walks whatever that map holds,
    // so a variant cannot be added without a rendering.
    for (const variant of Object.values(ArtifactPriorityVariant)) {
      const { container, unmount } = render(
        <ArtifactPriority priority={Priority.High} variant={variant} />
      );
      const mark = container.querySelector('[data-slot="artifact-priority"]');
      expect(mark, `variant ${variant} rendered no mark`).not.toBeNull();
      expect(mark?.getAttribute("data-variant")).toBe(variant);
      unmount();
    }
  });

  it("shows the glyph exactly where the variant spec says", () => {
    for (const variant of Object.values(ArtifactPriorityVariant)) {
      expect(
        hasGlyph(
          <ArtifactPriority priority={Priority.High} variant={variant} />
        ),
        `variant ${variant} disagreed with its spec about the glyph`
      ).toBe(ARTIFACT_PRIORITY_VARIANT_SPEC[variant].glyph);
    }
  });

  it("names every member, and unset, with one vocabulary", () => {
    expect(
      markText(
        <ArtifactPriority
          priority={Priority.Urgent}
          variant={ArtifactPriorityVariant.Label}
        />
      )
    ).toContain(LABEL.URGENT);
    expect(
      markText(
        <ArtifactPriority
          priority={Priority.Low}
          variant={ArtifactPriorityVariant.Label}
        />
      )
    ).toContain(LABEL.LOW);
    expect(
      markText(
        <ArtifactPriority
          priority={null}
          variant={ArtifactPriorityVariant.Label}
        />
      )
    ).toContain("—");
  });

  it("orders the vocabulary by semantic rank, most urgent first and unset last", () => {
    // One explicit semantic rank, read through the champion's own rendering: a
    // deliberately scrambled input sorted by the shared comparator, then each
    // value painted, and the resulting WORDS compared against literals written
    // here. Reordering the ordinal map or sorting by spelling both turn this
    // red — lexicographically URGENT sorts last, not first.
    const scrambled: (string | null)[] = [
      Priority.Low,
      null,
      Priority.Urgent,
      Priority.Medium,
      Priority.High,
    ];
    const rendered = [...scrambled]
      .sort(comparePriorityByRank)
      .map((priority) =>
        markText(
          <ArtifactPriority
            priority={priority}
            variant={ArtifactPriorityVariant.BoardCard}
          />
        )
      );
    // `board-card` is the label-only variant, so each member entry is the word
    // alone and the unset entry is the mark plus its word.
    expect(rendered).toEqual(EXPECTED_RANK_ORDER);
  });

  it("paints the absent value's word only where the variant always paints one", () => {
    // ISS-9441: the absent path reads the spec's `label` mode, so a detail field
    // answers "no priority" in words — its own menu offers that state by name,
    // and a bare dash in a bordered field beside three fields that each name
    // their empty state reads as a disabled input rather than a value.
    expect(
      markText(
        <ArtifactPriority
          priority={null}
          variant={ArtifactPriorityVariant.DetailField}
        />
      )
    ).toBe(`—${LABEL.NONE}`);
    // The dense grid column is the exception and keeps the mark alone: its
    // header already names the concept, and a page of unset rows repeating the
    // word is the noise ISS-9665 avoided. Asserting both in one case is what
    // stops a fix for either one silently applying to the other.
    expect(
      markText(
        <ArtifactPriority
          priority={null}
          variant={ArtifactPriorityVariant.Label}
        />
      )
    ).toBe("—");
    // And a glyph-only variant stays silent on screen whatever its shell, so the
    // 20px slot on an artifact detail row does not grow a word.
    expect(
      visibleLabel(
        <ArtifactPriority
          priority={null}
          variant={ArtifactPriorityVariant.IconOnly}
        />
      )
    ).toBe("—");
  });

  it("mutes the label in a grid column and never in a detail field", () => {
    // ISS-9441: the colour is carried per shell by `ARTIFACT_PRIORITY_GEOMETRY`,
    // not hardcoded on the label. Hardcoded, the dense column's muted weight
    // reached the detail field too, where it sank the value to the weight of the
    // field's own caption and left Priority the only cell in that panel whose
    // value did not read at foreground.
    const cellLabel = render(
      <ArtifactPriority
        priority={Priority.High}
        variant={ArtifactPriorityVariant.Label}
      />
    );
    expect(
      cellLabel.container.querySelector(`${CHAMPION} > span.truncate`)
        ?.className
    ).toContain("text-muted-foreground");
    cellLabel.unmount();

    const detailLabel = render(
      <ArtifactPriority
        priority={Priority.High}
        variant={ArtifactPriorityVariant.DetailField}
      />
    );
    expect(
      detailLabel.container.querySelector(`${CHAMPION} > span.truncate`)
        ?.className
    ).not.toContain("text-muted-foreground");
    detailLabel.unmount();
  });

  it("reads a skewed member as unknown, never as none", () => {
    // The wire boundary, where the types do not bind: an artifact carrying a
    // member this build does not know must not be reported as carrying none.
    const text = markText(
      <ArtifactPriority
        priority={SKEWED_MEMBER}
        variant={ArtifactPriorityVariant.Label}
      />
    );
    expect(text).toContain(LABEL.UNKNOWN);
    expect(text).not.toContain(LABEL.NONE);
  });

  it("names the value on an icon-only variant, which paints no word", () => {
    // The glyph is decorative, so on this variant nothing would reach the
    // accessibility tree without the `sr-only` name — the value would be stated
    // in shape and hue alone (WCAG 1.4.1). It is also the only thing that tells
    // a reader an unrecognized member is unrecognized, since the glyph falls
    // back to the same three bars HIGH draws.
    const { container } = render(
      <ArtifactPriority
        priority={SKEWED_MEMBER}
        variant={ArtifactPriorityVariant.IconOnly}
      />
    );
    const mark = container.querySelector('[data-slot="artifact-priority"]');
    expect(mark?.querySelector(".sr-only")?.textContent).toBe(LABEL.UNKNOWN);
    // The sibling: a RECOGNIZED member on the same variant is named too, and
    // differently, so this cannot pass on a component that always says
    // "Unknown priority".
    const known = render(
      <ArtifactPriority
        priority={Priority.High}
        variant={ArtifactPriorityVariant.IconOnly}
      />
    );
    expect(
      known.container
        .querySelector('[data-slot="artifact-priority"]')
        ?.querySelector(".sr-only")?.textContent
    ).toBe(LABEL.HIGH);
  });

  it("drops the redundant default label only on the compact cell", () => {
    // The VISIBLE label, not the accessible one. Suppressing the word must not
    // also delete the value from the accessibility tree, so the `sr-only` name
    // is still there and `textContent` would still find it — which is exactly
    // why this reads the visible span.
    expect(
      visibleLabel(
        <ArtifactPriority
          priority={Priority.Medium}
          variant={ArtifactPriorityVariant.CompactCell}
        />
      )
    ).toBeNull();
    // The sibling positive: the same variant keeps a label that carries signal,
    // so "the label is absent" is not satisfied by a mark that never labels.
    expect(
      visibleLabel(
        <ArtifactPriority
          priority={Priority.High}
          variant={ArtifactPriorityVariant.CompactCell}
        />
      )
    ).toBe(LABEL.HIGH);
    // And the non-compact cell keeps it.
    expect(
      visibleLabel(
        <ArtifactPriority
          priority={Priority.Medium}
          variant={ArtifactPriorityVariant.Label}
        />
      )
    ).toBe(LABEL.MEDIUM);
    // The suppressed one is still NAMED, so the row is readable by ear.
    expect(
      srOnlyLabel(
        <ArtifactPriority
          priority={Priority.Medium}
          variant={ArtifactPriorityVariant.CompactCell}
        />
      )
    ).toBe(LABEL.MEDIUM);
  });

  it("never suppresses a skewed member as if it were the quiet default", () => {
    expect(
      showsArtifactPriorityLabel(
        ArtifactPriorityVariant.CompactCell,
        SKEWED_MEMBER
      )
    ).toBe(true);
    expect(
      showsArtifactPriorityLabel(
        ArtifactPriorityVariant.CompactCell,
        Priority.Medium
      )
    ).toBe(false);
  });
});

/**
 * Exhaustive by type over the approved state vocabulary: a state added to
 * `ArtifactPriorityState` fails typecheck here until it is given a case, so the
 * champion cannot declare a state it does not render.
 *
 * `Hover` is the one case with no assertion of its own — it is a CSS state the
 * row's own `group-hover` owns and nothing the mark can be put into from props.
 * Named rather than omitted so the gap is visible.
 */
const STATE_CASE: Readonly<
  Record<ArtifactPriorityState, () => ReactElement | null>
> = {
  [ArtifactPriorityState.Loading]: () => (
    <ArtifactPriority
      loadingLabel="Loading priority"
      priority={Priority.High}
      state="loading"
      variant={ArtifactPriorityVariant.Label}
    />
  ),
  [ArtifactPriorityState.None]: () => (
    <ArtifactPriority priority={null} variant={ArtifactPriorityVariant.Label} />
  ),
  [ArtifactPriorityState.Unknown]: () => (
    <ArtifactPriority
      priority={SKEWED_MEMBER}
      variant={ArtifactPriorityVariant.Label}
    />
  ),
  [ArtifactPriorityState.Error]: () => (
    <ArtifactPriority
      errorLabel="Could not load"
      priority={Priority.High}
      state="error"
      variant={ArtifactPriorityVariant.Label}
    />
  ),
  [ArtifactPriorityState.Disabled]: () => (
    <ArtifactPriority
      disabled
      priority={Priority.High}
      variant={ArtifactPriorityVariant.Label}
    />
  ),
  [ArtifactPriorityState.ReadOnly]: () => (
    <ArtifactPriority
      priority={Priority.High}
      variant={ArtifactPriorityVariant.Label}
    />
  ),
  [ArtifactPriorityState.Selected]: () => (
    <ArtifactPriority
      priority={Priority.High}
      selected
      variant={ArtifactPriorityVariant.Label}
    />
  ),
  [ArtifactPriorityState.FocusVisible]: () => (
    <ArtifactPriority
      focusVisible
      priority={Priority.High}
      variant={ArtifactPriorityVariant.Label}
    />
  ),
  [ArtifactPriorityState.Hover]: () => null,
  [ArtifactPriorityState.Editing]: () => (
    <ArtifactPriority
      editing
      priority={Priority.High}
      variant={ArtifactPriorityVariant.Label}
    />
  ),
  [ArtifactPriorityState.MutationActivity]: () => (
    <ArtifactPriority
      mutationActivity
      priority={Priority.High}
      variant={ArtifactPriorityVariant.Label}
    />
  ),
};

describe("ArtifactPriority — the approved states", () => {
  it("renders a mark for every state a prop or a value can produce", () => {
    for (const state of Object.values(ArtifactPriorityState)) {
      const element = STATE_CASE[state]();
      if (!element) {
        continue;
      }
      const { container, unmount } = render(element);
      expect(
        container.querySelector('[data-slot="artifact-priority"]'),
        `state ${state} rendered no mark`
      ).not.toBeNull();
      unmount();
    }
  });

  it("reports loading as loading, and never as the value", () => {
    const { container } = render(
      STATE_CASE[ArtifactPriorityState.Loading]() ?? <span />
    );
    const mark = container.querySelector(CHAMPION);
    expect(mark?.textContent ?? "").not.toContain(LABEL.HIGH);
    // The positive half, and the load-bearing one: without it, a component that
    // rendered nothing at all would satisfy the negative above. The caller's
    // `loadingLabel` is what names the wait, so a skeleton with the wrong name
    // is red too.
    const loading = mark?.querySelector(LOADING_MARK);
    expect(loading).not.toBeNull();
    expect(loading?.textContent).toContain(LOADING_LABEL);
  });

  it("reports an error as an error, and never as the value", () => {
    const { container } = render(
      STATE_CASE[ArtifactPriorityState.Error]() ?? <span />
    );
    const mark = container.querySelector(CHAMPION);
    // The load-bearing half: deleting the error branch falls through to painting
    // "High", which contains no "No priority", so a lone absence assertion here
    // stayed green against a component with no error state at all.
    const error = mark?.querySelector(ERROR_MARK);
    expect(error).not.toBeNull();
    expect(error?.getAttribute("aria-label")).toBe(ERROR_LABEL);
    expect(mark?.textContent ?? "").not.toContain(LABEL.HIGH);
  });

  it("lets loading and error outrank an UNSET value, not only a set one", () => {
    // Where the precedence can actually be broken. Every other state case
    // carries a set value, so swapping the two checks in the component produced
    // byte-identical output and the file stayed green while a pending read
    // painted the empty-value dash as though it were a measured answer.
    for (const state of ["loading", "error"] as const) {
      const { container, unmount } = render(
        <ArtifactPriority
          errorLabel={ERROR_LABEL}
          loadingLabel={LOADING_LABEL}
          priority={null}
          state={state}
          variant={ArtifactPriorityVariant.Label}
        />
      );
      const mark = container.querySelector(CHAMPION);
      expect(
        mark?.querySelector('[data-slot="grid-empty-value"]'),
        `${state} painted the empty mark over its own state`
      ).toBeNull();
      unmount();
    }
    // The sibling that keeps the assertion above honest: with no state, the same
    // variant and the same null DOES paint the dash.
    const { container } = render(
      <ArtifactPriority
        priority={null}
        variant={ArtifactPriorityVariant.Label}
      />
    );
    expect(
      container.querySelector('[data-slot="grid-empty-value"]')
    ).not.toBeNull();
  });

  it("forwards the design system's disabled, selected and focus-visible marks", () => {
    // Each is a prop the champion must hand to the design system's state
    // helpers. Covered before only by "some mark rendered", which a champion
    // that dropped all three on the floor still satisfied.
    const cases = [
      [ArtifactPriorityState.Disabled, "data-cell-disabled"],
      [ArtifactPriorityState.Selected, "data-cell-selected"],
      [ArtifactPriorityState.FocusVisible, "data-cell-focus-visible"],
    ] as const;
    for (const [state, attribute] of cases) {
      const { container, unmount } = render(STATE_CASE[state]() ?? <span />);
      expect(
        container.querySelector(CHAMPION)?.getAttribute(attribute),
        `${state} dropped ${attribute}`
      ).toBe("true");
      unmount();
    }
    // The sibling negative on the same three targets, so "the attribute is
    // there" cannot pass on a mark that always sets it.
    const { container } = render(
      STATE_CASE[ArtifactPriorityState.ReadOnly]() ?? <span />
    );
    const idle = container.querySelector(CHAMPION);
    for (const [, attribute] of cases) {
      expect(idle?.getAttribute(attribute)).toBeNull();
    }
  });

  it("announces a write in flight, behind the gate", () => {
    const { container } = render(
      gated(STATE_CASE[ArtifactPriorityState.MutationActivity]() ?? <span />)
    );
    expect(container.querySelector(CHAMPION)?.getAttribute("aria-busy")).toBe(
      "true"
    );
    // The sibling negative on the same target, so "aria-busy is set" cannot be
    // satisfied by a mark that always sets it.
    const settled = render(
      gated(
        <ArtifactPriority
          priority={Priority.High}
          variant={ArtifactPriorityVariant.Label}
        />
      )
    );
    expect(
      settled.container.querySelector(CHAMPION)?.getAttribute("aria-busy")
    ).toBeNull();
  });

  it("keeps both activity treatments off the screen with the gate closed", () => {
    // The closed-by-default half (ISS-4779): no priority mark carried either
    // treatment before this ticket, so with the gate shut both surfaces must
    // render exactly as they shipped. The gated cases above are what stops this
    // passing on a champion that simply never implements them.
    for (const state of [
      ArtifactPriorityState.MutationActivity,
      ArtifactPriorityState.Editing,
    ]) {
      const { container, unmount } = render(STATE_CASE[state]() ?? <span />);
      const mark = container.querySelector(CHAMPION);
      expect(mark?.getAttribute("aria-busy"), `${state} leaked`).toBeNull();
      expect(mark?.getAttribute("data-editing"), `${state} leaked`).toBeNull();
      expect(mark?.className, `${state} leaked`).not.toContain("opacity-70");
      unmount();
    }
  });

  it("marks the mark as being edited over, and not otherwise", () => {
    const editing = render(
      gated(STATE_CASE[ArtifactPriorityState.Editing]() ?? <span />)
    );
    expect(
      editing.container.querySelector(CHAMPION)?.getAttribute("data-editing")
    ).toBe("true");
    const idle = render(
      gated(STATE_CASE[ArtifactPriorityState.ReadOnly]() ?? <span />)
    );
    expect(
      idle.container.querySelector(CHAMPION)?.getAttribute("data-editing")
    ).toBeNull();
  });
});

/**
 * Whether the champion offers "no priority" on each shipped surface.
 *
 * Exhaustive by type, so a surface added to the vocabulary fails typecheck here
 * until it answers. Written out rather than asserted universally: "every
 * supported surface clears" would make `allowsUnset` a field no test permits to
 * be false, and this table is also where a surface that genuinely refuses the
 * clear would be recorded. The artifact and project rows are ISS-9833's, ruled
 * 2026-09-14; the branch and session rows are ISS-10332's (operator ruling
 * 2026-09-21), which superseded the 2026-09-11 ruling that those rows hold no
 * priority — both now carry `Artifact.priority` and `PATCH` clears it with
 * `null`.
 */
const EXPECTED_UNSET_AFFORDANCE: Readonly<
  Record<ArtifactPrioritySurface, boolean>
> = {
  [ArtifactPrioritySurface.Artifact]: true,
  [ArtifactPrioritySurface.Project]: true,
  [ArtifactPrioritySurface.Branch]: true,
  [ArtifactPrioritySurface.Session]: true,
};

describe("artifact priority unset capability", () => {
  it("answers each shipped surface the way that surface declares", () => {
    // ISS-9441 dropped `projects.priority`'s NOT NULL and DEFAULT and taught the
    // update validator the clear, so the project row above is no longer a value
    // the schema forbids.
    for (const surface of Object.values(ArtifactPrioritySurface)) {
      expect(
        allowsArtifactPriorityUnset(ARTIFACT_PRIORITY_SUPPORT[surface]),
        `surface ${surface}`
      ).toBe(EXPECTED_UNSET_AFFORDANCE[surface]);
    }
  });

  it("refuses the clear on either half of a surface's declaration", () => {
    // SYNTHETIC declarations, because no shipped surface is
    // supported-but-not-clearable: read off the map alone, the `allowsUnset`
    // conjunct does no work in any case, and deleting it would leave this suite
    // green.
    expect(
      allowsArtifactPriorityUnset({
        adapter: "test",
        allowsUnset: true,
        supported: true,
      })
    ).toBe(true);
    expect(
      allowsArtifactPriorityUnset({
        adapter: "test",
        allowsUnset: false,
        supported: true,
      })
    ).toBe(false);
    // And the other conjunct: an unsupported surface carries no priority, so it
    // can never offer the item whatever else it says.
    expect(
      allowsArtifactPriorityUnset({
        adapter: "test",
        reason: "carries no priority",
        supported: false,
      })
    ).toBe(false);
  });
});
