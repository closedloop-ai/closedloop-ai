"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import { cn } from "@repo/design-system/lib/utils";
import { LockIcon, UsersIcon } from "lucide-react";
import { teamBreakdown } from "../mock";

// The account gate, planted inside the one chart you can't see solo: the team
// comparison. The real chart renders behind glass — teammates' numbers are
// there, just out of reach until an account exists and the org-of-one is
// provisioned server-side.
export const TeamComparisonGate = ({
  account,
  highlight,
  onCreateAccount,
}: {
  account: boolean;
  highlight: boolean;
  onCreateAccount: () => void;
}) => (
  <Card
    className={cn(
      "relative overflow-hidden",
      highlight && !account && "ring-2 ring-primary/60"
    )}
  >
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base">
        <UsersIcon className="size-4" />
        How your team uses AI
      </CardTitle>
      <CardDescription>
        Sessions run by you and each teammate, compared side by side.
      </CardDescription>
    </CardHeader>
    <CardContent className="relative">
      <div
        className={cn(
          "h-64 transition",
          account ? "" : "pointer-events-none select-none opacity-60 blur-[6px]"
        )}
      >
        <CategoryBarChart
          data={[...teamBreakdown]}
          horizontal
          showValueLabels
        />
      </div>

      {account ? null : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-card/40 to-card/80 px-7 text-center">
          <LockIcon aria-hidden="true" className="size-6 text-primary" />
          <div className="max-w-[360px]">
            <p className="font-semibold text-sm tracking-tight">
              See how others use AI
            </p>
            <p className="mt-1.5 text-pretty text-muted-foreground text-xs leading-relaxed">
              Create a free account to get more insights about your sessions,
              invite your teammates, and compare how AI is used across your org.
              Your numbers stay on this Mac; nothing syncs without your
              permission.
            </p>
          </div>
          <Button onClick={onCreateAccount}>
            <UsersIcon />
            Create a free account
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Free to start · You always own your local data
          </span>
        </div>
      )}
    </CardContent>
  </Card>
);
