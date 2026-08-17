import { LoopCommandLabel } from "@repo/app/shared/components/status-badge";
import { badgeVariants } from "@repo/design-system/components/ui/badge";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import { TONE } from "@repo/design-system/components/ui/types";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * FEA-4035: there were THREE hand-maintained tone→color maps in the repo —
 * `badgeVariants`, `ToneBadge`'s own `toneClasses`, and `ToneLabel`'s
 * `TONE_TEXT_CLASS` — all named some version of "tone", and `ToneBadge` had
 * already drifted from `badgeVariants` on its `default` row.
 *
 * The consolidation routes `ToneBadge` and `LoopCommandLabel` through the shared
 * variant vocabulary. That is only a safe refactor if nothing on screen moves,
 * so these pin the RESOLVED utilities each tone renders — as literals, which are
 * the frozen pre-consolidation contract. If a mapping row is repointed at a
 * different variant, the utility changes and one of these fails.
 */

/** What each `Tone` rendered BEFORE the consolidation, class for class. */
const SHIPPED_TONE_UTILITIES: Record<string, string[]> = {
  [TONE.DEFAULT]: ["border-input-border", "bg-input", "text-foreground"],
  [TONE.SUCCESS]: ["border-success/25", "bg-success/12", "text-success"],
  [TONE.WARNING]: [
    "border-warning/30",
    "bg-warning/14",
    "text-warning-foreground",
  ],
  [TONE.DANGER]: [
    "border-destructive/25",
    "bg-destructive/12",
    "text-destructive",
  ],
  [TONE.INFO]: ["border-info/25", "bg-info/12", "text-info"],
  [TONE.ACCENT]: ["border-primary/20", "bg-primary/10", "text-primary"],
  [TONE.MUTED]: ["border-border", "bg-muted/70", "text-muted-foreground"],
};

describe("ToneBadge routed through badgeVariants (FEA-4035)", () => {
  for (const [tone, utilities] of Object.entries(SHIPPED_TONE_UTILITIES)) {
    it(`renders the ${tone} tone with the utilities it shipped`, () => {
      render(<ToneBadge label={`${tone} label`} tone={tone as never} />);
      const badge = screen.getByText(`${tone} label`);
      for (const utility of utilities) {
        expect(badge.className).toContain(utility);
      }
    });
  }

  it("keeps the geometry the component owns, not the variant", () => {
    // The pill shape is `ToneBadge`'s, not a tone's — repointing the color
    // source must not have taken the geometry with it.
    render(<ToneBadge label="geometry" tone={TONE.SUCCESS} />);
    const badge = screen.getByText("geometry");
    for (const utility of ["h-6", "rounded-full", "px-2.5", "font-semibold"]) {
      expect(badge.className).toContain(utility);
    }
  });
});

describe("the ai badge variant (FEA-4035)", () => {
  it("reads the theme's --ai pair, matching the literal it replaces", () => {
    // `status-badge.tsx` maintained `COLOR_AI` as
    // "bg-ai/10 text-ai-foreground border-ai/30". The variant has to be that
    // exact treatment or every AI-toned badge in the product shifts.
    const resolved = badgeVariants({ variant: "ai" });
    for (const utility of ["border-ai/30", "bg-ai/10", "text-ai-foreground"]) {
      expect(resolved).toContain(utility);
    }
  });

  it("gives ToneLabel an ai tone that reads the on-surface token", () => {
    // `--ai` is tuned to sit under a chip's wash; as plain text on `--card` it
    // fails AA, which is why `success`/`info` already reach for `-foreground`.
    render(<ToneLabel variant="ai">Plan</ToneLabel>);
    expect(screen.getByText("Plan").className).toContain("text-ai-foreground");
  });
});

describe("LoopCommandLabel routed through ToneLabel (FEA-4035)", () => {
  // The three tones the fourteen loop commands collapse to, each with the text
  // utility the deleted bespoke map spelled out.
  const COMMAND_TEXT_UTILITY: [LoopCommand, string, string][] = [
    [LoopCommand.Plan, "Plan", "text-ai-foreground"],
    [LoopCommand.Execute, "Execute", "text-info-foreground"],
    [LoopCommand.Manual, "Manual", "text-warning-foreground"],
  ];

  for (const [command, label, utility] of COMMAND_TEXT_UTILITY) {
    it(`renders ${label} with the color its bespoke span used`, () => {
      render(<LoopCommandLabel command={command} />);
      expect(screen.getByText(label).className).toContain(utility);
    });
  }

  it("keeps the plain-label chrome the bespoke span rendered", () => {
    // Same element, same three base utilities — the consolidation is a swap of
    // WHO owns the color, not a restyle.
    render(<LoopCommandLabel command={LoopCommand.Plan} />);
    const label = screen.getByText("Plan");
    for (const utility of ["truncate", "font-medium", "text-xs"]) {
      expect(label.className).toContain(utility);
    }
    // Never boxed: a low-variance categorical value reads as clutter in a pill,
    // which is the whole reason `ToneLabel` exists beside `Badge`.
    expect(label.getAttribute("data-slot")).not.toBe("badge");
  });
});
