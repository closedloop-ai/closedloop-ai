"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { FlameIcon, TrophyIcon } from "lucide-react";
import { publicProfile } from "../mock";
import { BadgeChip } from "./badge-styles";

// The public, shareable/embeddable profile card, the /p/<uuid> vision. It
// consumes ONLY the `publicProfile` projection from the mock — a narrowed shape
// that excludes every private record (spend, efficiency) and internal-only
// field. Nothing here filters the full internal dataset at render time, so the
// private $ figures never ship in this module's data. Above the card sits a
// mocked OG/embed preview so the design review can judge the shared-link
// treatment.

// Where "View on Closedloop" points — the authenticated in-app profile.
const IN_APP_PROFILE_URL = "https://app.closedloop.dev/northwind/users/dana-w";

export function PublicSharePage({ onBack }: { onBack: () => void }) {
  const {
    name,
    title,
    org,
    initials,
    metrics,
    windowLabel,
    streakDays,
    orgPercentile,
    badges,
    publicUrl,
  } = publicProfile;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <EmbedPreview onBack={onBack} />

      {/* The shareable card itself, styled as a standalone public artifact. */}
      <Card className="overflow-hidden border-border bg-card">
        <div className="bg-muted/40 px-6 py-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Avatar className="size-14">
                <AvatarFallback className="font-semibold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <h1 className="font-semibold text-xl tracking-tight">{name}</h1>
                <p className="text-muted-foreground text-sm">{title}</p>
              </div>
            </div>
            {orgPercentile === null ? null : (
              <Badge className="font-semibold text-xs" variant="warning">
                Top {orgPercentile}% at {org}
              </Badge>
            )}
          </div>
        </div>
        <CardContent className="space-y-6 px-6 py-6">
          <div className="space-y-3">
            {/* States the snapshot window so the figures below can't read as
                a lifetime total next to the Achievements badges, which
                genuinely are lifetime (#4285 review). */}
            <p className="font-semibold text-muted-foreground text-xs uppercase tracking-[0.12em]">
              {windowLabel}
            </p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
              {metrics.map((metric) => (
                <div className="space-y-1" key={metric.key}>
                  <p className="font-semibold text-muted-foreground text-xs uppercase tracking-[0.12em]">
                    {metric.label}
                  </p>
                  <p className="flex items-baseline gap-1 font-semibold text-2xl tracking-tight">
                    {metric.value}
                    {metric.unitLabel ? (
                      <span className="font-medium text-muted-foreground text-xs">
                        {metric.unitLabel}
                      </span>
                    ) : null}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-xs">
              <FlameIcon
                aria-hidden="true"
                className="size-3.5 text-destructive"
              />
              {streakDays}-day streak
            </span>
            {badges.map((badge) => (
              <BadgeChip badge={badge} key={badge.key} />
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-border border-t pt-4">
            <p className="text-muted-foreground text-xs">
              Verified by Closedloop · {publicUrl}
            </p>
            <Button asChild size="sm" variant="outline">
              <a href={IN_APP_PROFILE_URL}>View on Closedloop</a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <p className="text-center text-muted-foreground text-xs">
        Cost and spend figures are never shared on this page.
      </p>
    </main>
  );
}

// A mock of the link-unfurl / OG card a platform (LinkedIn, Slack) would render
// when the public URL is pasted. Presentational only; driven by the OG template
// slots on `publicProfile` so it stays in sync with the card's numbers.
function EmbedPreview({ onBack }: { onBack: () => void }) {
  const { og, publicUrl } = publicProfile;
  return (
    <div className="space-y-3">
      <Button
        className="-ml-2 text-muted-foreground"
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        Back to in-app profile
      </Button>
      <div className="space-y-2">
        <p className="font-semibold text-muted-foreground text-xs uppercase tracking-[0.12em]">
          Link preview
        </p>
        <Card className="flex flex-row items-stretch overflow-hidden border-border bg-card">
          <div className="grid w-28 shrink-0 place-items-center bg-primary/10 text-primary">
            <TrophyIcon aria-hidden="true" className="size-8" />
          </div>
          <div className="min-w-0 space-y-1 px-4 py-3">
            <p className="truncate font-semibold text-sm">{og.title}</p>
            <p className="line-clamp-2 text-muted-foreground text-xs">
              {og.subtitle}
            </p>
            <p className="text-muted-foreground text-xs">{publicUrl}</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
