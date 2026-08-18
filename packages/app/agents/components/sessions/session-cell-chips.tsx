"use client";

// Cross-slice import (agents ← insights), deliberate: `providerOf` is the ONE
// provider-attribution rule (FEA-4027 hoisted it for exactly this kind of
// reuse); re-declaring the model→provider inference here would be the second
// inference table that drifts from the first.
import {
  OTHER_MODEL_PROVIDER,
  providerOf,
} from "@repo/app/insights/lib/model-provider";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import type { AutonomyTier } from "../../lib/autonomy";
import { getAutonomyShortLabel, getAutonomyTier } from "../../lib/autonomy";
import { resolveHarnessLabel } from "../../lib/harness-labels";

/**
 * ISS-6005 — the Harness / Model / Autonomy column treatments, per the Sessions
 * prototype (`apps/prototypes/app/p/sessions/components/session-cells.tsx`, the
 * SoT for these cells; Mike confirmed the pills directly).
 *
 * ## Standing-rule note, so nobody strips these
 *
 * The design-system rule "no badge where a plain string works" does NOT apply
 * here: the prototype explicitly specifies these pills and the operator has
 * directly confirmed them. This is the same authority that REMOVED pills
 * elsewhere (ISS-5666 Session column, ISS-5840 Cost column). The rule is:
 * pills exactly where the prototype specifies them, nowhere else.
 *
 * ## Mechanism vs. content
 *
 * The prototype uses bare `title=` attributes; production keeps its Radix
 * `Tooltip → Chip` scaffold (keyboard-reachable trigger, focus ring) and takes
 * only the CONTENT from the prototype — a native `title` is not
 * keyboard-reachable, so regressing to it would trade a11y for nothing.
 *
 * Null handling stays in `sessions-table.tsx`: the table returns the shared
 * `GridEmptyValue` sentinel BEFORE reaching these components, because
 * `isEmptyCellValue` identifies an empty cell by element TYPE and a wrapper
 * hides it (the `SessionCostCell` lesson).
 */

/**
 * Neutral outlined pill holding only the harness name — no icon, no tint.
 *
 * Truncates like the model chip beside it. The prototype gets away without it
 * because its harnesses are a closed enum of five short words; production's
 * `resolveHarnessLabel` deliberately degrades an UNRECOGNIZED harness to its raw
 * string, and `Chip` is `overflow-hidden whitespace-nowrap`, so an un-truncated
 * long label would cut flush against the rounded edge inside the 124px track
 * with no ellipsis to say it had been cut. No tooltip: this pill is not
 * interactive in the prototype and a name-only chip has nothing to explain.
 */
export function SessionHarnessChip({ harness }: { harness: string }) {
  return (
    <Chip
      className="min-w-0"
      data-testid={SESSION_HARNESS_CHIP_TEST_ID}
      variant="outline"
    >
      <span className="truncate">{resolveHarnessLabel(harness)}</span>
    </Chip>
  );
}

/**
 * Outlined pill with a small provider-colored dot plus the model id. The dot is
 * a redundant enhancer — the id text carries the information, so this is not
 * color-alone (WCAG 1.4.1). Tooltip content per the prototype:
 * `<provider> · <model>`.
 */
export function SessionModelChip({ model }: { model: string }) {
  const attributed = providerOf(model);
  const provider =
    attributed === OTHER_MODEL_PROVIDER
      ? SESSION_UNKNOWN_PROVIDER_TOOLTIP_LABEL
      : attributed;
  const dotClass =
    SESSION_MODEL_PROVIDER_DOT_CLASS[attributed] ??
    SESSION_MODEL_PROVIDER_DOT_FALLBACK_CLASS;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Chip
          className="min-w-0 gap-1.5"
          data-testid={SESSION_MODEL_CHIP_TEST_ID}
          interactive
          tabIndex={0}
          variant="outline"
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full bg-current",
              dotClass
            )}
          />
          <span className="truncate">{model}</span>
        </Chip>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-words">
        {`${provider} · ${model}`}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Colored tier pill. The label and variant come from the same tier
 * classification (`getAutonomyTier`, the calibrated `@repo/api` SSOT the
 * Autonomy filter facet reads), so the pill and the facet can never disagree
 * about which tier a score is in. The numeric score does NOT render in the
 * cell; it lives in the tooltip only, per the prototype
 * (`Autonomy score N of 100`).
 *
 * ⚠️ Deliberate divergence from the prototype's tier WORDS, named in the PR:
 * the prototype mock spells the tiers High / Medium / Low with 67/34 cutoffs,
 * but production's tier vocabulary is the calibrated High / Mixed / Guided
 * (70/35, `@repo/api/src/session-autonomy-tiers` — evidence-backed, shared
 * with the Autonomy facet and the detail Properties panel). Adopting the mock's
 * words would make the column disagree with the facet that filters it. The
 * prototype's TREATMENT (colored pill, score tooltip-only) is taken verbatim;
 * the tier vocabulary stays the product's one SSOT.
 */
export function SessionAutonomyChip({ autonomy }: { autonomy: number }) {
  const tier = getAutonomyTier(autonomy);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Chip
          className={SESSION_AUTONOMY_TIER_LABEL_CLASS[tier]}
          data-testid={SESSION_AUTONOMY_CHIP_TEST_ID}
          interactive
          tabIndex={0}
          variant={SESSION_AUTONOMY_TIER_CHIP_VARIANT[tier]}
        >
          {getAutonomyShortLabel(autonomy)}
        </Chip>
      </TooltipTrigger>
      <TooltipContent>{`Autonomy score ${autonomy} of 100`}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Dot token per provider label (the prototype's `MODEL_PROVIDER_CONFIG`
 * dotClass transcription — tokens only, never a hardcoded brand hex). Keyed by
 * `providerOf`'s label vocabulary; an unrecognized provider falls back to the
 * muted dot below rather than rendering an uncolored artifact.
 */
const SESSION_MODEL_PROVIDER_DOT_CLASS: Readonly<Record<string, string>> = {
  Anthropic: "text-primary",
  OpenAI: "text-success",
  Google: "text-info",
};

/** The `Other`/unknown-provider dot — quiet, claims nothing. */
const SESSION_MODEL_PROVIDER_DOT_FALLBACK_CLASS = "text-muted-foreground";

/**
 * What the tooltip calls a model whose provider cannot be attributed.
 *
 * `providerOf` answers `Other` — correct as a BUCKET name in an insights
 * grouping, but it is enum vocabulary, and a tooltip reading "Other ·
 * some-model-2026" tells a user nothing. The prototype (this ticket's SoT for
 * tooltip content) spells the same bucket `Model` in its `MODEL_PROVIDER_CONFIG`
 * fallback, which reads as a plain label rather than a leaked classifier state.
 * Only the DISPLAY word is remapped — `providerOf` stays the one attribution
 * rule and still keys the dot token.
 */
const SESSION_UNKNOWN_PROVIDER_TOOLTIP_LABEL = "Model";

/**
 * Tier → chip variant, per the prototype's `AUTONOMY_TIER_CONFIG` (High green,
 * middle tier blue, low muted), mapped onto production's tier vocabulary.
 * `Record`-keyed for compile-time exhaustiveness: a new tier cannot ship
 * without choosing its tone. `unknown` is unreachable from a numeric score
 * (only a null score classifies as unknown, and the table renders the shared
 * empty glyph before this component), but the entry keeps the map total.
 */
const SESSION_AUTONOMY_TIER_CHIP_VARIANT: Readonly<
  Record<AutonomyTier, "success" | "info" | "muted">
> = {
  high: "success",
  mixed: "info",
  guided: "muted",
  unknown: "muted",
};

/**
 * Tier → LABEL color, overriding the tone variant's own text token.
 *
 * The `success` and `info` chip variants set `text-success` / `text-info`, which
 * are the SATURATED tone tokens meant for fills and borders. Measured against
 * the card background at this chip's 12px, `info` lands at 2.90:1 in dark and
 * 3.32:1 in light, and `success` at 2.81:1 in light — under the 4.5:1 WCAG
 * 1.4.3 floor for body-size text, and the reference screenshots for this ticket
 * were dark. The cell this pill replaced was plain foreground text, so shipping
 * the raw variant would take a legible column to a failing one on EVERY row.
 *
 * The `-foreground` tone tokens are the design system's own answer to this —
 * `chip.tsx`'s `warning` variant already reaches for `text-warning-foreground`
 * for the same reason. Overriding the label color here rather than editing the
 * shared variants keeps the fix scoped to the column this ticket introduces;
 * retuning `success`/`info` for every consumer is a design-system change that
 * deserves its own ticket. `muted` already resolves to `text-muted-foreground`
 * and needs no override.
 */
const SESSION_AUTONOMY_TIER_LABEL_CLASS: Readonly<
  Record<AutonomyTier, string>
> = {
  high: "text-success-foreground",
  mixed: "text-info-foreground",
  guided: "",
  unknown: "",
};

/** Stable hooks for the treatment regression coverage. */
export const SESSION_HARNESS_CHIP_TEST_ID = "session-harness-chip";
export const SESSION_MODEL_CHIP_TEST_ID = "session-model-chip";
export const SESSION_AUTONOMY_CHIP_TEST_ID = "session-autonomy-chip";
