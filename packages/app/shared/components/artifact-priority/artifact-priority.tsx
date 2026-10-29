"use client";

import {
  ARTIFACT_PRIORITY_GEOMETRY,
  ARTIFACT_PRIORITY_VARIANT_SPEC,
  ArtifactPriorityShell,
  paintsArtifactPriorityAbsentLabel,
  showsArtifactPriorityLabel,
} from "@repo/app/shared/components/artifact-priority/artifact-priority-contract";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import type { ArtifactPriorityVariant } from "@repo/app/shared/lib/artifact-priority-ownership";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { PriorityBadge } from "@repo/design-system/components/ui/priority-badge";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  getTableCellPrimitiveStateAttributes,
  getTableCellPrimitiveStateClassName,
  getTableCellPrimitiveStateValue,
  type TableCellPrimitiveStateProps,
} from "@repo/design-system/components/ui/table-cell-primitives";
import {
  isPriorityValue,
  priorityLabel,
} from "@repo/design-system/lib/priority-order";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

/**
 * ISS-9307 — the one thing that paints an artifact's priority.
 *
 * Every surface that showed a priority used to assemble its own glyph, its own
 * label lookup and, on the search results, its own tone map; ISS-9439
 * inventoried four label maps and two rank maps grown that way. This component
 * is the single renderer those collapse onto, with the approved variant set
 * from `artifact-priority-ownership` choosing the presentation rather than each
 * caller choosing it again.
 *
 * `data-slot="artifact-priority"` is the hook the single-path test uses: every
 * priority glyph and every priority word on a champion-owned surface must sit
 * inside one of these, so a reintroduced page-private fork is a test failure
 * rather than a review miss.
 *
 * The interaction half is `ArtifactPriorityEditor`; this component is inert on
 * purpose, so a read-only surface cannot accidentally acquire a control.
 */
export function ArtifactPriority({
  className,
  disabled,
  editing,
  errorLabel,
  focusVisible,
  loadingLabel,
  mutationActivity,
  priority,
  selected,
  state,
  variant,
}: {
  className?: string;
  /**
   * The editor is open over this value. Kept as a prop rather than read from
   * the DOM so the mark can quiet itself while the menu is the thing being
   * read.
   */
  editing?: boolean;
  /** A write for this value is in flight (`aria-busy`). */
  mutationActivity?: boolean;
  /**
   * The stored value. `null` is "no priority", a state an artifact genuinely
   * holds (ISS-9665). Typed as a string rather than `Priority` because this is
   * the render boundary for a wire value: a member only a newer peer knows
   * reaches here at runtime and must read as unknown, never as none.
   */
  priority: string | null;
  variant: ArtifactPriorityVariant;
} & TableCellPrimitiveStateProps) {
  const spec = ARTIFACT_PRIORITY_VARIANT_SPEC[variant];
  const stateValue = getTableCellPrimitiveStateValue({
    disabled,
    errorLabel,
    focusVisible,
    loadingLabel,
    selected,
    state,
  });
  const geometry = ARTIFACT_PRIORITY_GEOMETRY[spec.shell];
  // ISS-9307, under the ISS-4779 closed-by-default policy: `editing` and
  // `mutation-activity` are treatments no priority mark carried before, so they
  // wait behind the `batch-706-champion-ui` key. Read HERE, once, because this is
  // the module that swaps on them — every absorbed surface then inherits one
  // answer without any of them threading a boolean in. `…Optional` so a mount
  // site with no flag provider (Storybook, a bare row test) resolves closed.
  const activityTreatment = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY
  );
  const busy = Boolean(activityTreatment && mutationActivity);
  const overlaid = Boolean(activityTreatment && editing);
  const wrap = (children: ReactNode) => (
    <span
      {...getTableCellPrimitiveStateAttributes({
        disabled,
        focusVisible,
        selected,
      })}
      aria-busy={busy ? true : undefined}
      className={cn(
        "inline-flex min-w-0 items-center",
        geometry.wrap,
        (overlaid || busy) && "opacity-70",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        }),
        className
      )}
      data-editing={overlaid ? true : undefined}
      data-slot="artifact-priority"
      data-variant={variant}
    >
      {children}
    </span>
  );

  // Loading and error are facts about the READ, so they outrank the value: a
  // skeleton that also paints "No priority" would report a value the surface
  // does not have yet.
  if (stateValue) {
    return wrap(stateValue);
  }
  if (priority === null) {
    return wrap(<ArtifactPriorityAbsent variant={variant} />);
  }
  if (spec.shell === ArtifactPriorityShell.Badge && isPriorityValue(priority)) {
    return wrap(<PriorityBadge priority={priority} />);
  }
  const showsLabel = showsArtifactPriorityLabel(variant, priority);
  return wrap(
    <>
      {spec.glyph && (
        // Decorative: the word beside it, or the `sr-only` one below when this
        // variant paints no word, is what names the value. Left named it would
        // announce "High High".
        //
        // A member only a newer peer knows still draws a glyph: `PriorityIcon`
        // has its own documented skew fallback, and suppressing the glyph here
        // instead left an icon-only row rendering a truncated word in a 20px box,
        // which named the value to nobody.
        <span
          className={cn("flex shrink-0 items-center", geometry.glyphBox)}
          data-priority-glyph
        >
          <PriorityIcon aria-hidden priority={priority} />
        </span>
      )}
      {showsLabel ? (
        <span className={cn("truncate", geometry.text)}>
          {priorityLabel(priority)}
        </span>
      ) : (
        // The glyph is the only visible statement on this variant, and it is
        // decorative, so without this the value is stated in shape and hue alone
        // (WCAG 1.4.1) and reaches the accessibility tree nowhere — which is also
        // how an unrecognized member would read as the three-bar glyph with
        // nothing saying it is unrecognized. A trigger's own `aria-label`
        // overrides its contents, so this never doubles up on an editor.
        <span className="sr-only">{priorityLabel(priority)}</span>
      )}
    </>
  );
}

/**
 * What a variant shows for an artifact that holds no priority.
 *
 * A badge falls to plain type, because a tinted pill for an absent value would
 * give "none" more weight than "Urgent". Every other shell draws the design
 * system's empty-value mark, which is what the grid, the artifact rows and the
 * filter facet already render.
 *
 * Which variants answer "no priority" by name rather than with a bare dash is
 * `paintsArtifactPriorityAbsentLabel`'s, not this function's: the control that
 * wraps this mark reads the same predicate to decide whether its own
 * `aria-label` would contradict the word beside it (ISS-9441).
 */
function ArtifactPriorityAbsent({
  variant,
}: {
  variant: ArtifactPriorityVariant;
}) {
  const { shell } = ARTIFACT_PRIORITY_VARIANT_SPEC[variant];
  if (shell === ArtifactPriorityShell.Badge) {
    return <span className="text-muted-foreground">{priorityLabel(null)}</span>;
  }
  // `GridEmptyValue` sets `text-sm` on its own element, so the wrapper's scale
  // never reaches it: without the shell's own text classes the grid's unset rows
  // would draw a dash one step larger than every value beside them.
  const mark = (
    <GridEmptyValue className={ARTIFACT_PRIORITY_GEOMETRY[shell].text} />
  );
  if (!paintsArtifactPriorityAbsentLabel(variant)) {
    return mark;
  }
  return (
    <>
      {/* Decorative once the word is beside it: the label states the value, so
          leaving the dash named would announce "— No priority". Same rule as the
          glyph above and as the menu's own unset item. */}
      <span aria-hidden="true">{mark}</span>
      <span className={cn("truncate", ARTIFACT_PRIORITY_GEOMETRY[shell].text)}>
        {priorityLabel(null)}
      </span>
    </>
  );
}
