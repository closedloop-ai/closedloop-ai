import {
  StatusDot,
  ToneBadge,
} from "@repo/design-system/components/ui/primitives/status-badge";
import type { Tone } from "@repo/design-system/components/ui/types";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * ISS-5036 (wongk): every tone `StatusDot` can render, rendered.
 *
 * The dot became design-system API when the Sessions list needed a standalone
 * liveness mark, and it brought its own `dotToneClasses` map with it. Inside a
 * pill the dot always takes the `bg-current` branch, so mounting `ToneBadge`
 * alone — all this file used to do — executed none of those seven classes. A
 * tone with no rendered surface is a tone nobody can review, and the whole point
 * of extracting the mark was to stop a second hand-rolled dot drifting from it.
 */
const TONES: readonly Tone[] = [
  "default",
  "success",
  "warning",
  "danger",
  "info",
  "accent",
  "muted",
];

const ToneBadgeGallery = () => (
  <div className="space-y-6">
    <div className="flex flex-wrap gap-2">
      <ToneBadge label="Default" tone="default" />
      <ToneBadge label="Success" pulse tone="success" />
      <ToneBadge label="Warning" tone="warning" />
      <ToneBadge label="Danger" tone="danger" />
      <ToneBadge label="Info" tone="info" />
      <ToneBadge label="Accent" tone="accent" />
      <ToneBadge label="Muted" tone="muted" />
    </div>

    {/* Standalone dot, static — the `tone` branch of `dotToneClasses`, once per
        tone, so all seven colors are on screen next to each other. */}
    <div className="flex flex-wrap items-center gap-4">
      {TONES.map((tone) => (
        <span className="flex items-center gap-1.5 text-xs" key={tone}>
          <StatusDot tone={tone} />
          {tone}
        </span>
      ))}
    </div>

    {/* ISS-5279: the pill-level ring pulse — the treatment a Sessions row uses to
        say its transcript is still uploading without spending a second pill on
        the fact. A ring, not the pill's opacity: fading the pill would fade the
        11px status word with it, and that word is what the treatment exists to
        keep. The ring is the mark on its own: PR review took the dot's opacity
        pulse OFF the ringed pill, because two animations on one 24px chip read
        as one busy pill rather than as two facts. First two pills are the ring
        in two tones; third is the dot `pulse` alone, for the comparison. */}
    <div className="flex flex-wrap items-center gap-2">
      <ToneBadge label="Active" pulseRing tone="success" />
      <ToneBadge label="Running" pulseRing tone="info" />
      <ToneBadge label="Active" pulse tone="success" />
    </div>

    {/* ISS-5282 (wongk): the dotless pill. `showDot={false}` is a real visual
        variant, not internal plumbing — its whole job is to sit on one line with
        toned state pills and match their height, weight and type scale while
        carrying a count rather than a state (the Sessions row-qualifier overflow
        counter). That match is what regresses silently in a refactor, and it is
        only visible when the two are ADJACENT, so the case is composed as the
        real row is: toned pills first, counter last. */}
    <div className="flex flex-wrap items-center gap-2">
      <ToneBadge label="Awaiting input" tone="warning" />
      <ToneBadge label="Local only" tone="muted" />
      <ToneBadge label="+2" showDot={false} tone="muted" />
    </div>

    {/* Same seven, pulsing — pins the shared `--animate-status-pulse` token to a
        rendered surface so it cannot drift from the dot inside a pill. */}
    <div className="flex flex-wrap items-center gap-4">
      {TONES.map((tone) => (
        <span className="flex items-center gap-1.5 text-xs" key={tone}>
          <StatusDot pulse tone={tone} />
          {tone} pulse
        </span>
      ))}
    </div>

    {/* The other half of the split: NO `tone`, so the dot inherits its parent's
        text color via `bg-current`. This is the branch `ToneBadge` itself uses;
        without it the inherit path only ever renders inside a pill. */}
    <div className="flex flex-wrap items-center gap-4">
      <span className="flex items-center gap-1.5 text-info text-xs">
        <StatusDot />
        inherits `bg-current`
      </span>
      <span className="flex items-center gap-1.5 text-destructive text-xs">
        <StatusDot pulse />
        inherits, pulsing
      </span>
    </div>
  </div>
);

const meta = {
  title: "Design System/Primitives/Status Badge",
  component: ToneBadgeGallery,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof ToneBadgeGallery>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
