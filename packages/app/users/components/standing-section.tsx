"use client";

import type { UserProfileStanding } from "@repo/api/src/types/user";
import { Alert, AlertTitle } from "@repo/design-system/components/ui/alert";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { FlameIcon } from "lucide-react";

// FEA-4108: Standing section — the consecutive-active-days streak. Faithful to
// the profile prototype's StreakTile (flair.tsx). The whole section is gated on
// real data: it renders nothing when the user has no streak (no active day), so
// the profile never shows a fake zero streak. Rank is intentionally omitted —
// the global cross-org ranking service is unbuilt (FEA-4122); the streak tile
// sits at its natural width until the rank tile(s) join it in a grid once that
// service lands.

type StandingSectionProps = {
  standing: UserProfileStanding | null;
  isLoading: boolean;
  isError: boolean;
};

export function StandingSection({
  standing,
  isLoading,
  isError,
}: StandingSectionProps) {
  // Widget independence (FEA-4108): most users have no streak, so this section
  // renders nothing for them. Staying quiet while the read is in flight avoids
  // promising a "Standing" heading + skeleton that then yanks itself away once
  // the query resolves to nothing. The section is optional by design, so nothing
  // is lost by waiting until there is real data to show.
  if (isLoading) {
    return null;
  }

  // A failing streak read surfaces an inline error rather than an infinite
  // skeleton, and never blocks the other profile widgets.
  if (isError) {
    return (
      <StandingShell>
        <Alert variant="error">
          <AlertTitle>Couldn't load standing</AlertTitle>
        </Alert>
      </StandingShell>
    );
  }

  // Real-data gate: with no streak there is nothing true to show, so the whole
  // section is hidden rather than rendering a fabricated zero.
  if (!standing?.streak) {
    return null;
  }

  // Rank is deferred (FEA-4122), so the streak tile is the only tile today. It
  // sits at its natural width rather than under a three-column grid that would
  // leave two-thirds of the row empty under the heading; the grid comes back
  // with the rank tile(s) when that service lands.
  return (
    <StandingShell>
      <div className="max-w-sm">
        <StreakTile
          bestDays={standing.streak.bestDays}
          currentDays={standing.streak.currentDays}
        />
      </div>
    </StandingShell>
  );
}

function StandingShell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="standing-heading" className="space-y-4">
      <h2
        className="font-semibold text-lg tracking-tight"
        id="standing-heading"
      >
        Standing
      </h2>
      {children}
    </section>
  );
}

function StreakTile({
  currentDays,
  bestDays,
}: {
  currentDays: number;
  bestDays: number;
}) {
  // A run that ended more than a day ago comes back as currentDays 0 — a common
  // state, not an edge case (anyone active last week but not today/yesterday).
  // Leading a section called "Standing" with a 3xl "0 days" under a flame reads
  // as failure, so when there is no live run we lead with the personal best (the
  // true positive signal) and state the broken current run as muted support.
  const hasLiveStreak = currentDays > 0;
  const { eyebrow, leadValue, leadNoun, support } = hasLiveStreak
    ? {
        eyebrow: "Current streak",
        leadValue: currentDays,
        leadNoun: currentDays === 1 ? "day" : "days",
        support: `Personal best ${bestDays.toLocaleString()} ${
          bestDays === 1 ? "day" : "days"
        }`,
      }
    : {
        eyebrow: "Personal best",
        leadValue: bestDays,
        leadNoun: bestDays === 1 ? "day" : "days",
        support: "No active streak right now",
      };
  return (
    <Card>
      <CardContent className="flex items-center gap-2 px-4 py-4 sm:px-6">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-[0.12em]">
            <FlameIcon
              aria-hidden="true"
              className="size-3.5 text-destructive"
            />
            {eyebrow}
          </p>
          <p className="flex items-baseline gap-1.5 font-semibold text-3xl tracking-tight">
            {leadValue.toLocaleString()}
            <span className="font-medium text-muted-foreground text-sm">
              {leadNoun}
            </span>
          </p>
          <p className="text-muted-foreground text-sm">{support}</p>
        </div>
      </CardContent>
    </Card>
  );
}
